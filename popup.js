// 免费版BookmarkHub - popup 逻辑
const $ = id => document.getElementById(id);

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function setBusy(busy) {
  ['btnUpload', 'btnDownload', 'btnRemoveAll', 'btnRefresh'].forEach(id => { $(id).disabled = busy; });
}

async function refreshCounts() {
  const st = await chrome.storage.local.get(['localCount', 'remoteCount']);
  $('localCount').textContent = st.localCount ?? '-';
  $('remoteCount').textContent = st.remoteCount ?? '-';
}

// 打开弹窗就实时算本地数（不信缓存），云端仍用缓存
async function recountLocal() {
  try {
    const tree = await chrome.bookmarks.getTree();
    let n = 0;
    const walk = list => { if (!Array.isArray(list)) return; for (const it of list) { if (it.url) n += 1; else walk(it.children); } };
    walk(tree[0].children || []);
    $('localCount').textContent = n;
  } catch { /* 保持缓存值 */ }
}

// 点刷新：本地重算 + 云端拉 Gist 实际条数
$('btnRefresh').addEventListener('click', async () => {
  const btn = $('btnRefresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  await recountLocal();
  setStatus('<span class="spin"></span>拉取云端…');
  const r = await chrome.runtime.sendMessage({ name: 'fetchRemoteCount' });
  btn.disabled = false;
  btn.classList.remove('spinning');
  if (r && r.ok) {
    $('remoteCount').textContent = r.count;
    setStatus(`云端实际 ${r.count} 条（上次更新：${r.date}）`, 'ok');
  } else {
    setStatus(`拉取失败：${r ? r.error : '未知错误'}`, 'err');
  }
});

async function ensureConfigured() {
  const o = await chrome.runtime.sendMessage({ name: 'getOptions' });
  if (!o.githubToken || !o.gistID) {
    setStatus('未配置，请先点「设置」', 'err');
    return false;
  }
  return true;
}

$('btnUpload').addEventListener('click', async () => {
  if (!(await ensureConfigured())) return;
  setBusy(true);
  setStatus('<span class="spin"></span>上传中…');
  await chrome.runtime.sendMessage({ name: 'upload' });
  setBusy(false);
  setStatus('上传完成', 'ok');
  refreshCounts();
});

$('btnDownload').addEventListener('click', async () => {
  if (!(await ensureConfigured())) return;
  // 下载会覆盖本地书签，二次确认
  const btn = $('btnDownload');
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '↓ 确认覆盖';
    setStatus('再次点「确认覆盖」生效，4 秒后自动取消', '');
    setTimeout(() => {
      if (btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        btn.textContent = '↓ 下载';
        if ($('status').textContent.startsWith('再次点')) setStatus('', '');
      }
    }, 4000);
    return;
  }
  btn.dataset.armed = '';
  btn.textContent = '↓ 下载';
  setBusy(true);
  setStatus('<span class="spin"></span>下载中…');
  await chrome.runtime.sendMessage({ name: 'download' });
  setBusy(false);
  setStatus('下载完成', 'ok');
  refreshCounts();
});

$('btnRemoveAll').addEventListener('click', async () => {
  const btn = $('btnRemoveAll');
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '确认清空？';
    setTimeout(() => {
      btn.dataset.armed = '';
      btn.textContent = '清空本地';
    }, 4000);
    return;
  }
  btn.dataset.armed = '';
  btn.textContent = '清空本地';
  setBusy(true);
  setStatus('<span class="spin"></span>清空中…');
  await chrome.runtime.sendMessage({ name: 'removeAll' });
  setBusy(false);
  setStatus('已清空本地书签', 'ok');
  refreshCounts();
});

$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('linkOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

recountLocal().then(refreshCounts);
