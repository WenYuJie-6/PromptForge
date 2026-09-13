// ============================================================
// check-download-ux.mjs —— 下载安装包交互（多种部署环境）
//
// 校验目标（在沙盒里真跑 downloadDesktopInstaller()）
//   1. HTTP 静态托管：点击 → 立刻触发 <a download> 下载绝对地址
//      https://<部署基址>/Latest-Setup.exe，全程无前置弹窗；
//   2. 地址推导优先级：用户填写的更新源 > 本页部署基址 > 相对回退；
//   3. 明确 404 时给出「未找到安装包」提示（且在下载动作之后，不阻塞主路径）；
//   4. file:// 协议：浏览器禁止脚本触发下载 → 只弹说明 + 推荐双击启动.bat，
//      不创建 <a>、不发起 fetch（协议层限制，代码不应徒劳尝试）；
//   5. 桌面版：直接提示「你使用的已经是桌面版」，不下载。
//
// 输入：js/ 全部脚本（沙盒按 index.html 顺序执行）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-download-ux: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印 FAIL 行并以退出码 1 结束
//
// 历史教训：旧版是「HEAD 探测 → 按结果弹窗 → 选 exe/msi → 再点一次」，
// 探测器在 file:// 下必然抛异常 → 引入"未知"第三态 → 第三态又弹窗安抚，
// 结果每次下载至少一个弹窗。本套件用「HTTP 下 dialogs 必须为空」把这条护栏钉死。
// ============================================================
import { makeEnv, loadAll, reporter } from './_check-lib.mjs';

const r = reporter('check-download-ux');

function setup(opt = {}) {
  const rec = { toast: [], dialogs: [], anchors: [], clipboard: [], fetches: [] };
  const env = makeEnv({
    url: opt.url || 'https://user.github.io/promptforge/',
    protocol: opt.protocol || 'https:',
    storage: opt.updateUrl ? { pf_settings: JSON.stringify({ updateUrl: opt.updateUrl }) } : {},
    globals: {
      __TAURI_INTERNALS__: opt.desktop ? { invoke: async () => null } : undefined,
      fetch: async (u) => {
        rec.fetches.push(String(u));
        return { ok: !opt.head404, status: opt.head404 ? 404 : 200 };
      },
    },
  });
  loadAll(env);
  // 覆盖 app.js 的顶层函数声明，改为记录型桩
  env.window.toast = (m) => { rec.toast.push(String(m)); };
  env.window.askDialog = (o) => { rec.dialogs.push(o); return Promise.resolve(opt.dialogOk !== false); };
  env.window.navigator.clipboard.writeText = async (t) => { rec.clipboard.push(String(t)); };
  env.window.PF_DEPLOY_BASE = opt.deployBase === undefined ? 'https://user.github.io/promptforge' : opt.deployBase;
  // 拦截 <a> 的创建与 click，以便断言「确实触发了下载」
  const origCreate = env.document.createElement.bind(env.document);
  env.document.createElement = (t) => {
    const e = origCreate(t);
    if (String(t).toLowerCase() === 'a') {
      rec.anchors.push(e);
      const oc = e.click.bind(e);
      e.click = () => { e.__clicked = true; oc(); };
    }
    return e;
  };
  rec.env = env;
  rec.download = () => env.eval('downloadDesktopInstaller()');
  return rec;
}

// ---- 0. 拦截器自检 ----
r.section('0. 拦截器自检');
{
  const t = setup();
  t.env.window.toast('探针');
  r.check(t.toast.length === 1 && t.toast[0] === '探针', '能拦截 toast（覆盖顶层函数声明生效）');
  const a = t.env.document.createElement('a');
  a.click();
  r.check(t.anchors.length === 1 && a.__clicked === true, '能拦截 <a> 创建与 click');
}

// ---- A. HTTP 一键下载 ----
r.section('A. HTTP 静态托管：一键直下');
{
  const t = setup();
  await t.download();
  r.eq(t.anchors.length, 1, '创建了 1 个 <a> 用于下载');
  const a = t.anchors[0] || {};
  r.check(a.__clicked === true, '下载被立即触发（a.click()）');
  r.eq(a.href, 'https://user.github.io/promptforge/Latest-Setup.exe', 'href 是绝对 https 地址');
  r.eq(a.download, 'PromptForge-Setup.exe', '下载文件名带产品名');
  r.eq(a.rel, 'noopener', '带 rel=noopener');
  r.eq(t.dialogs.length, 0, '全程没有任何前置弹窗');
  r.check(t.toast.some((m) => m.includes('已开始下载')), '给出「已开始下载」提示');
  r.eq(t.fetches.length, 1, '下载后仅一次后台复核请求');
  r.eq(t.fetches[0], a.href, '复核请求打在同一个地址上');
}

// ---- B. 地址推导 ----
r.section('B. 下载地址推导');
{
  const t = setup({ updateUrl: 'https://cdn.example.com/pf' });
  await t.download();
  r.eq(t.anchors[0].href, 'https://cdn.example.com/pf/Latest-Setup.exe', '用户填写的更新源优先于本页基址');
}
{
  const t = setup({ deployBase: 'https://user.github.io/promptforge/' });
  await t.download();
  r.eq(t.anchors[0].href, 'https://user.github.io/promptforge/Latest-Setup.exe', '基址带尾斜杠时不会拼出双斜杠');
}
{
  const t = setup({ deployBase: '' });
  await t.download();
  r.eq(t.anchors[0].href, 'Latest-Setup.exe', '无法推导基址时回退为相对路径（不产生畸形绝对地址）');
}
{
  const t = setup({ deployBase: 'http://127.0.0.1:14370' });
  await t.download();
  r.eq(t.anchors[0].href, 'http://127.0.0.1:14370/Latest-Setup.exe', '本地启动器场景指向 127.0.0.1 静态服务');
}

// ---- C. 404 ----
r.section('C. 安装包缺失（404）');
{
  const t = setup({ head404: true });
  await t.download();
  r.eq(t.anchors.length, 1, '先触发下载（主路径不被探测阻塞）');
  r.eq(t.dialogs.length, 1, '404 时给出一次提示');
  r.check(/未找到安装包/.test(t.dialogs[0].title || ''), '提示标题为「未找到安装包」');
  r.check(/Latest-Setup\.exe/.test(t.dialogs[0].body || ''), '提示里说明了缺失的文件名');
}

// ---- D. file:// ----
r.section('D. file:// 本地打开');
{
  const t = setup({ protocol: 'file:', url: 'file:///C:/PromptForge/index.html', deployBase: '' });
  await t.download();
  r.eq(t.dialogs.length, 1, '弹出一个说明对话框');
  r.check(/启动\.bat/.test(t.dialogs[0].body || ''), '说明里推荐双击 启动.bat');
  r.check(/浏览器/.test(t.dialogs[0].body || ''), '说明里解释了浏览器限制');
  r.eq(t.anchors.length, 0, '不创建 <a>（协议层禁止，不做徒劳尝试）');
  r.eq(t.fetches.length, 0, '不发起任何 fetch（file:// 下必然失败）');
  r.eq(t.clipboard.length, 1, '确认后复制启动器路径到剪贴板');
  r.check(/启动\.bat$/.test(t.clipboard[0]), '复制的内容以「启动.bat」结尾');
}
{
  const t = setup({ protocol: 'file:', url: 'file:///C:/PromptForge/index.html', deployBase: '', dialogOk: false });
  await t.download();
  r.eq(t.clipboard.length, 0, '用户关闭对话框时不复制任何内容');
}

// ---- E. 桌面版 ----
r.section('E. 桌面版');
{
  const t = setup({ desktop: true });
  await t.download();
  r.check(t.toast.some((m) => m.includes('已经是桌面版')), '提示「你使用的已经是桌面版」');
  r.eq(t.anchors.length, 0, '桌面版不触发下载');
  r.eq(t.dialogs.length, 0, '桌面版不弹任何对话框');
  r.eq(t.fetches.length, 0, '桌面版不发起请求');
}

r.done();
