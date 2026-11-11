// 免费版BookmarkHub - options 页逻辑
const $ = id => document.getElementById(id);

// ---------- 捐赠位配置 ----------
// 二维码图：直接替换扩展目录下的 donate-wechat.png / donate-alipay.png（400×400 或任意正方形）
// 爱发电链接：填你的主页（https://afdian.com/a/你的ID）；留空则隐藏链接按钮
const DONATE = {
  link: '',
};

function initDonate() {
  if (!DONATE.link) {
    $('donateLink').style.display = 'none';
  } else {
    $('donateLink').href = DONATE.link;
  }
}

function setMsg(el, text, cls) {
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

async function loadOptions() {
  const o = await chrome.runtime.sendMessage({ name: 'getOptions' });
  $('githubToken').value = o.githubToken || '';
  $('gistID').value = o.gistID || '';
  $('gistFileName').value = o.gistFileName || 'BookmarkHub';
  $('enableNotify').checked = !!o.enableNotify;
}

async function saveOptions() {
  const patch = {
    githubToken: $('githubToken').value.trim(),
    gistID: $('gistID').value.trim(),
    gistFileName: $('gistFileName').value.trim() || 'BookmarkHub',
    enableNotify: $('enableNotify').checked,
  };
  await chrome.runtime.sendMessage({ name: 'saveOptions', patch });
  setMsg($('saveMsg'), '✓ 已保存', 'ok');
  setTimeout(() => setMsg($('saveMsg'), '', ''), 2000);
}

// ---------- Token 校验 ----------
$('btnCheckToken').addEventListener('click', async () => {
  // 先临时保存 token，校验的是当前输入框里的值
  await saveOptions();
  setMsg($('tokenMsg'), '校验中…', '');
  const r = await chrome.runtime.sendMessage({ name: 'checkToken' });
  if (r && r.ok) {
    setMsg($('tokenMsg'), `✓ 有效，账号：${r.login}`, 'ok');
  } else {
    setMsg($('tokenMsg'), `✗ ${r ? r.error : '未知错误'}`, 'err');
  }
});

// ---------- Gist 列表 ----------
$('btnListGists').addEventListener('click', async () => {
  await saveOptions();
  setMsg($('gistMsg'), '拉取中…', '');
  const r = await chrome.runtime.sendMessage({ name: 'listGists' });
  if (!r || !r.ok) {
    setMsg($('gistMsg'), `✗ ${r ? r.error : '未知错误'}`, 'err');
    return;
  }
  setMsg($('gistMsg'), `共 ${r.gists.length} 个 Gist，点击行尾「使用」选定`, 'ok');
  const tbody = $('gistTbody');
  tbody.innerHTML = '';
  for (const g of r.gists) {
    const tr = document.createElement('tr');
    const files = g.files.join(', ');
    tr.innerHTML = `
      <td class="desc-cell" title="${escapeHtml(g.description)}">${escapeHtml(g.description)}</td>
      <td class="desc-cell" title="${escapeHtml(files)}">${escapeHtml(files)}</td>
      <td>${escapeHtml((g.updated_at || '').slice(0, 10))}</td>
      <td class="btn-cell"><button data-id="${escapeHtml(g.id)}">使用</button></td>
    `;
    tr.querySelector('button').addEventListener('click', () => {
      $('gistID').value = g.id;
      // 若该 gist 里有 BookmarkHub 同名文件，自动带出文件名
      const hit = g.files.find(f => /bookmarkhub/i.test(f));
      if (hit) $('gistFileName').value = hit;
      setMsg($('gistMsg'), `已选定 Gist：${g.id}`, 'ok');
    });
    tbody.appendChild(tr);
  }
  $('gistTableWrap').style.display = 'block';
});

// ---------- 新建 Gist ----------
$('btnCreateGist').addEventListener('click', async () => {
  await saveOptions();
  setMsg($('gistMsg'), '创建中…', '');
  const r = await chrome.runtime.sendMessage({ name: 'createGist' });
  if (r && r.ok) {
    $('gistID').value = r.id;
    setMsg($('gistMsg'), `✓ 已创建私有 Gist 并自动填入 ID：${r.id}`, 'ok');
  } else {
    setMsg($('gistMsg'), `✗ ${r ? r.error : '未知错误'}`, 'err');
  }
});

$('btnSave').addEventListener('click', saveOptions);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

loadOptions();
initDonate();
