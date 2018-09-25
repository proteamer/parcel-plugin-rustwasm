const path = require('path');
const commandExists = require('command-exists');
const childProcess = require('child_process');
const promisify = require('parcel-bundler/src/utils/promisify');
const exec = promisify(childProcess.execFile);
const pipeSpawn = require('parcel-bundler/src/utils/pipeSpawn');
const fs = require('parcel-bundler/src/utils/fs');
const urlJoin = require('parcel-bundler/src/utils/urlJoin');

const babelParser = require('@babel/parser');
const template = require('@babel/template').default;
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const RustAsset = require('parcel-bundler/src/assets/RustAsset.js');

// Track installation status so we don't need to check more than once
let wasmPackInstalled = false;

class RustwasmAsset extends RustAsset {
  constructor(name, options) {
    super(name, options);
    this.type = 'js';
  }

  async wasmPackBuild(cargoDir) {
    const args = [
      '--verbose',
      'build',
      '--target',
      'browser',
      //'--mode',
      //'no-install',
      '--no-typescript',
    ];

    await exec('wasm-pack', args, { cwd: cargoDir });
  }
  async collectDependencies() {}

  async cargoBuild(cargoConfig, cargoDir) {
    await this.installWASMPack();

    await this.wasmPackBuild(cargoDir);

    const pkgDir = path.join(cargoDir, 'pkg');
    const pkg = require(path.join(pkgDir, 'package.json'));

    const entryPoint = pkg.main || pkg.module || pkg.browser;

    const code = await fs.readFile(path.join(pkgDir, entryPoint), 'utf8');

    const ast = babelParser.parse(code, {
      filename: path.join(pkgDir, entryPoint),
      allowReturnOutsideFunction: true,
      strictMode: false,
      sourceType: 'module',
      plugins: ['exportDefaultFrom', 'exportNamespaceFrom', 'dynamicImport'],
    });

    let wasmExports = [];
    let wasmImportPath = null;

    traverse(ast, {
      Identifier(path) {
        if (path.isIdentifier({ name: 'wasm' })) {
          path.node.name = '__wasmInstanceExports';
        }
      },
      ExportDeclaration(path) {
        wasmExports.push(path.node.declaration.id.name);
        path.replaceWith(path.node.declaration);
      },
      ImportDeclaration(path) {
        wasmImportPath = `${path.node.source.value}.wasm`;
        path.remove();
      },
    });

    // add wasm file to dependencies
    const wasmDep = path.relative(
      path.dirname(this.name),
      path.join(pkgDir, wasmImportPath)
    );

    const wasmURL = urlJoin(
      this.options.publicURL,
      this.addURLDependency(wasmDep)
    );

    const wasmName = pkg.name;

    ast.program.body = computeWASMLoader(
      wasmName,
      wasmURL,
      wasmExports,
      ast.program.body
    );

    const output = generate(ast, {
      sourceMaps: this.options.sourceMaps,
      sourceFileName: this.relativeName,
    });

    this.code = output.code;
  }

  async installWASMPack() {
    if (wasmPackInstalled) return;

    try {
      await commandExists('wasm-pack');
      // wasm-pack depends on a library called wasm-bindgen.
      // wasm-bindgen requires that you use Rust 1.30.0 or
      // higher. This version is currently only available on
      // the nightly or beta channels. So we switch to nightly
      // channel.
      await exec('rustup', ['override', 'set', 'nightly']);
    } catch (e) {
      await pipeSpawn('cargo', ['install', 'wasm-pack']);
    }

    wasmPackInstalled = true;
  }

  async generate() {
    return [
      {
        type: 'js',
        value: this.code,
      },
    ];
  }
}

module.exports = RustwasmAsset;

const buildTemplate = template(`
  const __wasmId = ID;
  const __wasmURL = URL;
  const __exports = EXPORTS;

  let __wasmInstanceExports;

  module.exports = importWasm(__wasmURL, { ["./" + __wasmId]: __exports })
    .then(function(wasmModule) {
      __wasmInstanceExports = wasmModule.instance.exports;
      return __exports;
    });

  function importWasm(url, importObject) {
    return fetch(url)
      .then(function(res) {
        if (WebAssembly.instantiateStreaming) {
          return WebAssembly.instantiateStreaming(res, importObject);
        } else {
          return res.arrayBuffer().then(function(data) {
            return WebAssembly.instantiate(data, importObject);
          });
        }
      });
  }

  BODY
`);

function computeWASMLoader(id, url, imports, body) {
  const URL = t.stringLiteral(url);
  const ID = t.stringLiteral(id);
  const EXPORTS = t.objectExpression(
    imports.map(name =>
      t.objectProperty(t.stringLiteral(name), t.identifier(name))
    )
  );
  const BODY = body;

  return buildTemplate({ ID, URL, EXPORTS, BODY });
}
