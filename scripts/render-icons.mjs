import { _electron as electron } from 'playwright';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('test-results/icon-render');
mkdirSync(dir, { recursive: true });
mkdirSync('resources', { recursive: true });
copyFileSync('apps/web/public/logo.svg', 'apps/web/public/favicon.svg');
const main = `${dir}/main.cjs`;
writeFileSync(main, "const { app } = require('electron'); app.whenReady().then(() => {});\n");
const app = await electron.launch({
  args: [main, `--user-data-dir=${dir}/profile`],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});
try {
  const svg = readFileSync('apps/web/public/logo.svg', 'utf8');
  const png = await app.evaluate(async ({ app, BrowserWindow }, svg) => {
    await app.whenReady();
    const win = new BrowserWindow({
      show: false,
      width: 512,
      height: 512,
      useContentSize: true,
      transparent: true,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    });
    try {
      await win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg}`)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rendered = await win.webContents.capturePage(undefined, { stayHidden: true });
      return [512, 256].map((size) =>
        rendered.resize({ width: size, height: size }).toPNG().toString('base64'),
      );
    } finally {
      win.destroy();
    }
  }, svg);
  writeFileSync('apps/web/public/icon.png', Buffer.from(png[0], 'base64'));
  const small = Buffer.from(png[1], 'base64'),
    header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(small.length, 14);
  header.writeUInt32LE(22, 18);
  writeFileSync('resources/bot-bots.ico', Buffer.concat([header, small]));
  console.log('Updated SVG, PNG and Windows ICO icons.');
} finally {
  await app.close();
}
