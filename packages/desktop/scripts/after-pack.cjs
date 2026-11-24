/**
 * macOS 未配置 Developer ID 时给 .app 补一次 ad-hoc 签名：
 * Apple Silicon 上完全未签名的应用会启动失败；配合 mac.hardenedRuntime: false 即可正常运行。
 */
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // 有正式证书时由 electron-builder 签名，这里不插手。
  if (process.env.CSC_LINK) return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  } catch (error) {
    // 不让签名失败挡住发版；产物仍是可手动放行的未签名包。
    console.warn(`[after-pack] ad-hoc codesign failed: ${String(error)}`);
  }
};
