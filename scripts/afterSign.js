// electron-builder afterSign hook. We ship unsigned (no Apple Developer ID),
// but arm64 macOS refuses to run a bundle that isn't at least ad-hoc signed,
// and adding our own extraResources (aria2c, its dylibs, the CA bundle)
// after electron-builder's own pass can leave the bundle without a valid
// seal over those files. Force a full ad-hoc, deep re-sign here so the
// final .app passes `codesign --verify --deep --strict`.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // Extended attributes (e.g. inherited from Homebrew's Cellar, or AppleDouble
  // files) make codesign refuse the bundle with "resource fork, Finder
  // information, or similar detritus not allowed". Strip them first.
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  });
};
