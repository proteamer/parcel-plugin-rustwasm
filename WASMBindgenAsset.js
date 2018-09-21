const path = require('path');
const commandExists = require('command-exists');
const childProcess = require('child_process');
const promisify = require('parcel-bundler/src/utils/promisify');
const exec = promisify(childProcess.execFile);
const pipeSpawn = require('parcel-bundler/src/utils/pipeSpawn');
const md5 = require('parcel-bundler/src/utils/md5');
const fs = require('parcel-bundler/src/utils/fs');

const RustAsset = require('parcel-bundler/src/assets/RustAsset.js');

// Track installation status so we don't need to check more than once
let wasmBindgenInstalled = false;
let loaderPathCreated = false;

class WASMBindgenAsset extends RustAsset {
  constructor(name, options) {
    super(name, options);

    this.hashedName = md5(name);
    this.type = `wasm-${this.hashedName}`;
    this.loaderDir = path.join(this.options.cacheDir, '.wasm-loaders');
  }

  async cargoBuild(cargoConfig, cargoDir) {
    await super.cargoBuild(cargoConfig, cargoDir);

    // Generate wasm js wrapper via wasm-bindgen
    // wasm-bindgen creates two files:
    // <rust_name>_bg.wasm and <rust_name>.js

    // Install wasm-bindgen if needed
    await this.installWASMBindgen();

    const outDir = path.dirname(this.wasmPath);
    const args = [this.wasmPath, '--no-modules', '--out-dir', outDir];

    await exec('wasm-bindgen', args, {cwd: cargoDir});

    // replace original wasm file with new generated one
    this.wasmPath = this.wasmPath.replace(/\.wasm$/, '_bg.wasm');

    // Generate parcel wasm loader
    const warapperPath = this.wasmPath.replace(/_bg\.wasm$/, '.js');
    const wrapperContent = await fs.readFile(warapperPath, 'utf8');

    // We use custom file extentions so we can't use
    // WebAssembly.instantiateStreaming because of incorrect MIME type
    const loaderContent = `
      let initWasm;

      ${wrapperContent
        .replace('self.wasm_bindgen', 'initWasm')
        .replace(
          "typeof WebAssembly.instantiateStreaming === 'function'",
          'false',
        )}

      module.exports = function loadWASMBundle(bundle) {
        return initWasm(bundle).then(() => Object.assign({}, initWasm));
      }
    `;

    const loaderPath = path.join(
      this.loaderDir,
      `wasm-loader-${this.hashedName}.js`,
    );

    if (!loaderPathCreated) {
      loaderPathCreated = true;
      await fs.mkdirp(this.loaderDir);
    }

    await fs.writeFile(loaderPath, loaderContent);

    // Hack to dynamic registration wasm loader
    // Actually the issue is that particular wasm dependency
    // should be handled with specific loader however parcel
    // has limitation one file type - one loaed so we need use hack
    this.options.bundleLoaders[this.type] = {
      browser: loaderPath,
      node: loaderPath,
    };
  }

  async installWASMBindgen() {
    if (wasmBindgenInstalled) return;

    try {
      await commandExists('wasm-bindgen');
    } catch (e) {
      console.log('E', e)
      await pipeSpawn('cargo', ['install', 'wasm-bindgen-cli']);
    }

    wasmBindgenInstalled = true;
  }

  async generate() {
    return {
      [this.type]: {
        path: this.wasmPath,
        mtime: Date.now(),
      },
    };
  }
}

module.exports = WASMBindgenAsset;
