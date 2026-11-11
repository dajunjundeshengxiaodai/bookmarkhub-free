// 免费版BookmarkHub - background service worker
// 核心逻辑：书签树 <-> GitHub Gist 单文件同步
// 数据格式与原版 BookmarkHub 兼容：{version, createDate, bookmarks, browser}

const GITHUB_API = 'https://api.github.com';
const DEFAULTS = {
  githubToken: '',
  gistID: '',
  gistFileName: 'BookmarkHub',
  enableNotify: true,
};

// ---------- 配置存取（storage.sync，跨设备跟浏览器账号走） ----------
async function getSettings() {
  const st = await chrome.storage.sync.get('options');
  return { ...DEFAULTS, ...(st.options || {}) };
}

async function saveSettings(patch) {
  const cur = await getSettings();
  await chrome.storage.sync.set({ options: { ...cur, ...patch } });
}

// ---------- GitHub Gist API（原生 fetch，零依赖） ----------
async function gistRequest(path, opts = {}) {
  const s = await getSettings();
  const resp = await fetch(GITHUB_API + path, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${s.githubToken}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json;charset=utf-8',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let msg = `${resp.status} ${resp.statusText}`;
    try {
      const j = JSON.parse(text);
      if (j.message) msg = j.message;
    } catch {}
    if (resp.status === 401) msg = 'Token 无效或已过期 (401)';
    if (resp.status === 404) msg = 'Gist 不存在或 Token 无权限 (404)';
    if (resp.status === 403 && resp.headers.get('X-RateLimit-Remaining') === '0') {
      msg = 'GitHub API 限流，请稍后再试 (403)';
    }
    throw new Error(msg);
  }
  return resp.json();
}

async function gistGetContent() {
  const s = await getSettings();
  const gist = await gistRequest(`/gists/${s.gistID}`);
  const files = gist.files || {};
  const file = files[s.gistFileName];
  if (!file) return null;
  if (file.truncated && file.raw_url) {
    const r = await fetch(file.raw_url, { cache: 'no-store' });
    return r.text();
  }
  return file.content ?? null;
}

async function gistUpdate(content, description) {
  const s = await getSettings();
  return gistRequest(`/gists/${s.gistID}`, {
    method: 'PATCH',
    body: {
      description: description || s.gistFileName,
      files: { [s.gistFileName]: { content } },
    },
  });
}

async function gistList() {
  return gistRequest('/gists?per_page=100');
}

async function gistCreate(description) {
  const s = await getSettings();
  return gistRequest('/gists', {
    method: 'POST',
    body: {
      description: description || '免费版BookmarkHub 书签同步',
      files: { [s.gistFileName]: { content: '{"bookmarks":[]}' } },
      public: false,
    },
  });
}

// ---------- 浏览器类型 ----------
const BROWSER = { FIREFOX: 0, CHROME: 1, EDGE: 2 };
let browserType = BROWSER.CHROME;

// 根文件夹标准名（写入 Gist 的统一命名，跨浏览器通用）
const FolderNames = {
  MenuFolder: 'MenuFolder',       // Firefox 菜单栏
  ToolbarFolder: 'ToolbarFolder', // 书签栏
  UnfiledFolder: 'UnfiledFolder', // 其他书签
  MobileFolder: 'MobileFolder',   // 移动设备书签
};

// ---------- 书签树序列化 ----------
function stripNode(node) {
  const out = {
    title: node.title || '',
    children: undefined,
  };
  if (node.url) out.url = node.url;
  if (node.children) {
    out.children = node.children.map(stripNode);
  }
  return out;
}

async function detectBrowser() {
  const tree = await chrome.bookmarks.getTree();
  // Firefox 根 id 为 "root________"
  browserType = tree && tree[0] && tree[0].id === 'root________' ? BROWSER.FIREFOX : BROWSER.CHROME;
  return tree;
}

// Chrome: 1=书签栏 2=其他书签 3=移动设备书签; Firefox: toolbar_____/menu________/unfiled_____/mobile______
function normalizeRootTitles(tree) {
  const roots = tree[0].children || [];
  for (const root of roots) {
    switch (root.id) {
      case '1':
      case 'toolbar_____': root.title = FolderNames.ToolbarFolder; break;
      case 'menu________': root.title = FolderNames.MenuFolder; break;
      case '2':
      case 'unfiled_____': root.title = FolderNames.UnfiledFolder; break;
      case '3':
      case 'mobile______': root.title = FolderNames.MobileFolder; break;
    }
  }
  return roots.map(stripNode);
}

function countBookmarks(list) {
  let n = 0;
  if (!Array.isArray(list)) return n;
  for (const item of list) {
    if (item.url) n += 1;
    else n += countBookmarks(item.children);
  }
  return n;
}

// ---------- 本地书签清空（保留 4 个根文件夹） ----------
async function clearAllBookmarks() {
  const tree = await detectBrowser();
  const roots = (tree[0].children || []);
  // 收集每个根下的直接子项并整棵删除
  for (const root of roots) {
    for (const child of root.children || []) {
      if (child.id) {
        await chrome.bookmarks.removeTree(child.id);
      }
    }
  }
}

// ---------- 远端书签恢复（含跨浏览器根文件夹映射） ----------
async function restoreBookmarkList(list) {
  if (!Array.isArray(list)) return;
  for (const node of list) {
    const isStandardRoot = [
      FolderNames.MenuFolder,
      FolderNames.ToolbarFolder,
      FolderNames.UnfiledFolder,
      FolderNames.MobileFolder,
    ].includes(node.title);

    if (isStandardRoot) {
      // 把根文件夹的子项映射回当前浏览器对应的根 id
      let parentId;
      if (browserType === BROWSER.FIREFOX) {
        switch (node.title) {
          case FolderNames.MenuFolder: parentId = 'menu________'; break;
          case FolderNames.MobileFolder: parentId = 'mobile______'; break;
          case FolderNames.ToolbarFolder: parentId = 'toolbar_____'; break;
          default: parentId = 'unfiled_____';
        }
      } else {
        switch (node.title) {
          case FolderNames.MobileFolder: parentId = '3'; break;
          case FolderNames.ToolbarFolder: parentId = '1'; break;
          case FolderNames.UnfiledFolder:
          case FolderNames.MenuFolder:
          default: parentId = '2';
        }
      }
      for (const child of node.children || []) {
        child.parentId = parentId;
      }
      await restoreBookmarkList(node.children);
      continue;
    }

    // 普通节点：先建自己，再递归子级
    let created = { id: '', title: '' };
    try {
      created = await chrome.bookmarks.create({
        parentId: node.parentId,
        title: node.title,
        url: node.url,
      });
    } catch (e) {
      console.error('[免费版BookmarkHub] create failed:', created.title, e);
    }
    if (created.id && node.children && node.children.length > 0) {
      for (const child of node.children) {
        child.parentId = created.id;
      }
      await restoreBookmarkList(node.children);
    }
  }
}

// ---------- 通知 ----------
const ICON_DATA_URL = chrome.runtime.getURL('icons/48.png');

async function notify(title, message) {
  const s = await getSettings();
  if (!s.enableNotify) return;
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: ICON_DATA_URL,
      title,
      message: message || '',
    });
  } catch (e) {
    console.error('notify failed', e);
  }
}

// ---------- 上传 / 下载 ----------
let syncState = 'NONE'; // NONE | SYNC

async function uploadBookmarks() {
  syncState = 'SYNC';
  try {
    const s = await getSettings();
    if (!s.githubToken) throw new Error('未配置 GitHub Token');
    if (!s.gistID) throw new Error('未配置 Gist ID');
    if (!s.gistFileName) throw new Error('未配置 Gist 文件名');

    const tree = await detectBrowser();
    const data = {
      version: chrome.runtime.getManifest().version,
      createDate: Date.now(),
      bookmarks: normalizeRootTitles(tree),
      browser: navigator.userAgent,
    };
    await gistUpdate(JSON.stringify(data), s.gistFileName);
    const cnt = countBookmarks(data.bookmarks);
    await chrome.storage.local.set({ remoteCount: cnt, lastUpload: Date.now() });
    await notify('上传书签', `成功，共 ${cnt} 条`);
  } catch (e) {
    console.error(e);
    await notify('上传书签', `失败：${e.message}`);
  } finally {
    syncState = 'NONE';
    chrome.action.setBadgeText({ text: '' });
    updateLocalCount();
  }
}

async function downloadBookmarks() {
  syncState = 'SYNC';
  try {
    const s = await getSettings();
    const content = await gistGetContent();
    if (!content) {
      await notify('下载书签', `失败：Gist 文件 ${s.gistFileName} 不存在或为空`);
      return;
    }
    const data = JSON.parse(content);
    if (!data.bookmarks || data.bookmarks.length === 0) {
      await notify('下载书签', `失败：Gist 文件 ${s.gistFileName} 为空`);
      return;
    }
    await clearAllBookmarks();
    await restoreBookmarkList(data.bookmarks);
    const cnt = countBookmarks(data.bookmarks);
    await chrome.storage.local.set({ remoteCount: cnt, lastDownload: Date.now() });
    await notify('下载书签', `成功，共 ${cnt} 条`);
  } catch (e) {
    console.error(e);
    await notify('下载书签', `失败：${e.message}`);
  } finally {
    syncState = 'NONE';
    chrome.action.setBadgeText({ text: '' });
    updateLocalCount();
  }
}

async function removeAllBookmarks() {
  syncState = 'SYNC';
  try {
    await clearAllBookmarks();
    await notify('清空书签', '成功');
  } catch (e) {
    console.error(e);
    await notify('清空书签', `失败：${e.message}`);
  } finally {
    syncState = 'NONE';
    chrome.action.setBadgeText({ text: '' });
    updateLocalCount();
  }
}

// ---------- 本地书签计数（角标 + popup 显示） ----------
async function updateLocalCount() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const cnt = countBookmarks(tree[0].children || []);
    await chrome.storage.local.set({ localCount: cnt });
  } catch (e) { /* service worker 早期可能不可用 */ }
}

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.name === 'upload') {
    uploadBookmarks().then(() => sendResponse(true));
    return true;
  }
  if (msg.name === 'download') {
    downloadBookmarks().then(() => sendResponse(true));
    return true;
  }
  if (msg.name === 'removeAll') {
    removeAllBookmarks().then(() => sendResponse(true));
    return true;
  }
  if (msg.name === 'checkToken') {
    (async () => {
      try {
        const s = await getSettings();
        if (!s.githubToken) throw new Error('未填写 Token');
        const r = await fetch(GITHUB_API + '/user', {
          headers: {
            'Authorization': `Bearer ${s.githubToken}`,
            'Accept': 'application/vnd.github+json',
          },
        });
        if (!r.ok) throw new Error(`Token 校验失败 (${r.status})`);
        const u = await r.json();
        sendResponse({ ok: true, login: u.login });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.name === 'listGists') {
    (async () => {
      try {
        const s = await getSettings();
        if (!s.githubToken) throw new Error('未填写 Token');
        const gists = await gistList();
        sendResponse({ ok: true, gists: gists.map(g => ({
          id: g.id,
          description: g.description || '(无描述)',
          files: Object.keys(g.files || {}),
          public: g.public,
          updated_at: g.updated_at,
        })) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.name === 'createGist') {
    (async () => {
      try {
        const s = await getSettings();
        if (!s.githubToken) throw new Error('未填写 Token');
        const gist = await gistCreate();
        await saveSettings({ gistID: gist.id });
        sendResponse({ ok: true, id: gist.id });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.name === 'saveOptions') {
    saveSettings(msg.patch).then(() => sendResponse(true));
    return true;
  }
  if (msg.name === 'getOptions') {
    getSettings().then(o => sendResponse(o));
    return true;
  }
  if (msg.name === 'fetchRemoteCount') {
    (async () => {
      try {
        const s = await getSettings();
        if (!s.githubToken) throw new Error('未配置 Token');
        if (!s.gistID) throw new Error('未配置 Gist ID');
        const content = await gistGetContent();
        if (!content) throw new Error(`Gist 文件 ${s.gistFileName} 不存在或为空`);
        const data = JSON.parse(content);
        const cnt = countBookmarks(data.bookmarks);
        const date = data.createDate ? new Date(data.createDate).toLocaleString('zh-CN', { hour12: false }) : '未知';
        // 顺手缓存，下次开弹窗直接显示
        await chrome.storage.local.set({ remoteCount: cnt });
        sendResponse({ ok: true, count: cnt, date });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  // 其余消息不响应
  return false;
});

// ---------- 书签变动监听：角标提示有改动未同步 ----------
['onCreated', 'onChanged', 'onMoved', 'onRemoved'].forEach(evt => {
  chrome.bookmarks[evt].addListener(() => {
    if (syncState !== 'NONE') return;
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#F00' });
    updateLocalCount();
  });
});

// service worker 启动时刷新本地计数
updateLocalCount();
