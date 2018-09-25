module.exports = async function(bundler) {
  bundler.addAssetType('rs', require.resolve('./RustwasmAsset'));
};
