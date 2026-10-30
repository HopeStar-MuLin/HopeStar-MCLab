import io
import re

p = 'E:/MCLab/HMCL/HMCL/src/main/resources/assets/web/index.html'
s = io.open(p, encoding='utf-8').read()

start = s.index('<section class="page" id="page-download">')
end = s.index('</section>', start) + len('</section>')
old_section = s[start:end]

new_section = '''<section class="page" id="page-download">
        <!-- 下载页六个分类。游戏版本走 Mojang 清单，其余走 Modrinth -->
        <div class="dl-tabs" id="dl-tabs">
          <button data-dltab="game" class="on">游戏版本</button>
          <button data-dltab="modpack">整合包</button>
          <button data-dltab="mod">模组</button>
          <button data-dltab="resourcepack">资源包</button>
          <button data-dltab="shader">光影</button>
          <button data-dltab="world">世界</button>
        </div>

        <div class="dl-pane" id="dl-pane-game">
          <div class="dl-toolbar">
            <div class="seg" id="dl-filter">
              <button data-filter="release" class="active">正式版</button>
              <button data-filter="all">全部</button>
              <button data-filter="snapshot">快照</button>
              <button data-filter="old">远古</button>
            </div>
            <input class="dl-search" id="dl-search" type="text" placeholder="搜索版本号，例如 1.21.4" spellcheck="false">
            <span class="muted small" id="dl-count"></span>
            <button class="kbd-btn" id="dl-refresh" title="重新拉取版本清单">
              <svg viewBox="0 0 24 24"><path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
              <span>刷新</span>
            </button>
          </div>

          <div class="dl-progress" id="dl-progress" hidden>
            <div class="dl-progress-head">
              <span id="dl-progress-text">准备中…</span>
              <button class="link" id="dl-progress-hide">收起</button>
            </div>
            <div class="bar indeterminate"><i></i></div>
          </div>

          <div class="dl-list" id="dl-list">
            <div class="empty">正在从 Mojang 拉取版本清单…</div>
          </div>
        </div>

        <div class="dl-pane" id="dl-pane-addon" hidden>
          <div class="dl-toolbar">
            <input class="dl-search" id="ad-search" type="text" placeholder="搜索名称…" spellcheck="false">
            <select class="ad-select" id="ad-sort" title="排序方式">
              <option value="relevancy">相关性</option>
              <option value="downloads">下载量</option>
              <option value="updated">最近更新</option>
              <option value="new">最新发布</option>
            </select>
            <!-- 模组 / 资源包 / 光影要落到具体实例，整合包和世界不需要 -->
            <select class="ad-select" id="ad-instance" title="目标实例" hidden></select>
            <span class="muted small" id="ad-count"></span>
            <button class="kbd-btn" id="ad-import" title="从本地文件导入">
              <svg viewBox="0 0 24 24"><path d="M12 3v10m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
              <span id="ad-import-label">导入</span>
            </button>
          </div>

          <div class="ad-grid" id="ad-grid">
            <div class="empty">选择上方分类开始浏览</div>
          </div>

          <div class="ad-pager" id="ad-pager" hidden>
            <button class="btn ghost" id="ad-prev">上一页</button>
            <span class="muted small" id="ad-page-label"></span>
            <button class="btn ghost" id="ad-next">下一页</button>
          </div>
        </div>
      </section>'''

s = s[:start] + new_section + s[end:]

# 内容版本小窗（和加载器版本窗结构一致，独立一份避免状态串）
modal = '''
<!-- 内容（模组 / 资源包 / 光影 / 整合包）的版本选择窗 -->
<div class="modal hidden" id="adver-modal">
  <div class="modal-body card ver-body">
    <div class="modal-head">
      <h3 id="adver-title">选择版本</h3>
      <button class="icon-btn" id="adver-close">✕</button>
    </div>
    <div class="lm-list" id="adver-list"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="adver-cancel">取消</button>
    </div>
  </div>
</div>
'''
anchor = '<!-- 通用输入框（重命名用）'
assert anchor in s
s = s.replace(anchor, modal.strip() + '\n\n' + anchor, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('html ok')
