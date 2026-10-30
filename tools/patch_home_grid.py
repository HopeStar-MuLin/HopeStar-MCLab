import io

base = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web'

# ---------- app.css ----------
p = base + r'\app.css'
s = io.open(p, encoding='utf-8').read()

old = '''/* 实例卡：宽窗口一行 3–4 个，但单卡最宽 380px，不会被拉成整条 */
.grid.instances {
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  /* 上限 1140：4K 上 5 张卡不会被拉成 5 条宽条子 */
  max-width: 1140px;
}'''

new = '''/* 实例卡：列数跟着数量走，1 张铺满、2 张平分、3 张以上固定三列。
   4 张就是「上三下一」，第 4 张跟上面第一张左对齐，不会独占一行。 */
.grid.instances {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.grid.instances[data-count="1"] { grid-template-columns: minmax(0, 1fr); }
.grid.instances[data-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }

/* 第 6 格：满 5 个实例后代替「查看全部」按钮 */
.instance-more {
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 6px;
  border-style: dashed;
  color: var(--muted);
}
.instance-more:hover { color: var(--accent); border-color: var(--accent); }
.instance-more strong { font-size: 13.5px; font-weight: 600; }
.instance-more span { font-size: 12px; }'''

assert old in s, 'grid.instances css not found'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8').write(s)
print('css ok')

# ---------- app.js ----------
p = base + r'\app.js'
s = io.open(p, encoding='utf-8').read()

# renderInstanceGrid 整段替换
start = s.find('  function renderInstanceGrid() {')
assert start > 0
# 找到函数结束：下一个顶层 function
nxt = s.find('\n  function ', start + 10)
assert nxt > start
old_fn = s[start:nxt]

new_fn = '''  function renderInstanceGrid() {
    var grid = document.getElementById('instance-grid');
    var all = (state && state.instances) ? state.instances : [];
    var list = all.slice(0, 5);

    grid.innerHTML = '';

    // 空实例时整块隐藏，提示已经写在上面那张 hero 卡里了
    if (!list.length) {
      grid.hidden = true;
      grid.removeAttribute('data-count');
      return;
    }
    grid.hidden = false;

    list.forEach(function (inst) {
      var card = el('div', 'instance-card' + (inst.id === state.selected ? ' current' : ''));
      // 左侧色条按加载器着色（见 app.css）
      card.setAttribute('data-loader', inst.loader || '原版');
      card.appendChild(iconNode(inst, 'instance-icon'));

      var body = el('div', 'instance-body');
      body.appendChild(el('div', 'instance-name', inst.name));
      body.appendChild(el('div', 'instance-line',
        (inst.gameVersion || '') + ' · ' + (inst.loader || '原版') + (inst.loaderVersion ? ' ' + inst.loaderVersion : '')));
      var tags = el('div', 'instance-tags');
      tags.appendChild(el('span', 'tag', fmtSize(inst.size)));
      tags.appendChild(el('span', 'tag', fmtTime(inst.lastLaunch)));
      body.appendChild(tags);
      card.appendChild(body);

      var edit = el('button', 'icon-edit', '✎');
      edit.title = '更换图标';
      edit.addEventListener('click', function (e) {
        e.stopPropagation();
        openIconPicker(inst.id);
      });
      card.appendChild(edit);

      // 直接从这个实例进安装弹窗：已经装了的加载器会显示版本 + ↻
      var manage = el('button', 'icon-edit icon-manage', '⚙');
      manage.title = '加载器管理';
      manage.addEventListener('click', function (e) {
        e.stopPropagation();
        openLoaderModal(inst.gameVersion, inst.id);
      });
      card.appendChild(manage);

      card.addEventListener('click', function () {
        if (inst.id !== state.selected) { call('selectInstance', inst.id); }
      });
      card.addEventListener('dblclick', function () { call('launchInstance'); });

      grid.appendChild(card);
    });

    // 满 5 个之后，第 6 格换成「查看全部实例」，右上角那个按钮就收起来
    var hasMore = all.length > 5;
    if (hasMore) {
      var more = el('div', 'instance-card instance-more');
      more.appendChild(el('strong', null, '查看全部实例'));
      more.appendChild(el('span', null, '共 ' + all.length + ' 个'));
      more.addEventListener('click', function () { go('instances'); });
      grid.appendChild(more);
    }

    grid.setAttribute('data-count', String(list.length + (hasMore ? 1 : 0)));

    var allBtn = document.querySelector('#page-home .section-head [data-page="instances"]');
    if (allBtn) { allBtn.hidden = hasMore; }
  }'''

s = s[:start] + new_fn + s[nxt:]
io.open(p, 'w', encoding='utf-8').write(s)
print('js ok')
