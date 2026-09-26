/* ============================================================
 * 传统戏曲锣鼓经排练可视化
 *
 * 协作模型（两人同改一份已存方案）：
 * - 每份已存方案带稿号（revisions 只追加，head 指向最新稿）。
 * - 打开已存方案时，会话记住打开时的稿号 baseRev，保存时在同一方案上追加新稿号。
 * - 保存时若另一方已先存（head > baseRev），按 三方合并：
 *     · 两边没碰同一拍 → 自动合并并直接存出新稿号；
 *     · 同一拍同一乐器口令不同 → 保留本页内容，列出小节、乐器、两边口令；
 *     · 两边只添批注 → 按时间先后合并。
 * - 冲突未处理完，不能保存、也不能另存新方案。
 * - 恢复旧稿会在同一方案下生成新稿号，旧稿仍可查看。
 * - 冲突写进 localStorage 的会话区，刷新/重开后未结冲突仍在。
 * ========================================================== */

const PLANS_KEY = "wxyy-4-luogujing-plans";
const TABS_KEY = "wxyy-4-luogujing-tabs";
const LEGACY_KEY = "wxyy-4-luogujing-grid";

const instruments = [
  { name: "大锣", token: "仓", freq: 180 },
  { name: "鼓", token: "冬", freq: 120 },
  { name: "钹", token: "才", freq: 360 },
  { name: "小锣", token: "台", freq: 520 }
];
const steps = 16;

/* ---------------- 纯工具 ---------------- */

function uid() {
  return crypto.randomUUID();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyPattern() {
  return instruments.map(() => Array.from({ length: steps }, () => ""));
}

function defaultWork() {
  return {
    pieceName: "出场锣鼓-慢起",
    bpm: 96,
    loop: "",
    notes: [],
    pattern: instruments.map((instrument) =>
      Array.from({ length: steps }, (_, index) => (index % 4 === 0 ? instrument.token : "")))
  };
}

function normalizeNote(note) {
  if (note && typeof note === "object") {
    return { id: note.id || uid(), text: String(note.text ?? ""), at: note.at || new Date().toISOString() };
  }
  return { id: uid(), text: String(note), at: new Date().toISOString() };
}

function normalizeWork(work) {
  const base = defaultWork();
  const source = work && typeof work === "object" ? work : {};
  return {
    pieceName: typeof source.pieceName === "string" ? source.pieceName : base.pieceName,
    bpm: Number.isFinite(Number(source.bpm)) ? Number(source.bpm) : base.bpm,
    loop: source.loop === undefined || source.loop === null ? "" : String(source.loop),
    notes: Array.isArray(source.notes) ? source.notes.map(normalizeNote) : [],
    pattern: Array.isArray(source.pattern) && source.pattern.length === instruments.length
      ? source.pattern.map((row) => Array.from({ length: steps }, (_, i) => String(row?.[i] ?? "")))
      : base.pattern
  };
}

function beatLabel(index) {
  const measure = Math.floor(index / 4) + 1;
  const beat = (index % 4) + 1;
  return `${measure}-${beat}`;
}

function cellKey(row, step) {
  return `${row}:${step}`;
}

function fmtTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

/* ---------------- 三方合并（纯函数，可测试） ---------------- */

/**
 * 合并口令网格。返回 { merged, conflicts }。
 * resolvedKeys：已被用户处理过的格子（本页为准），再次合并时不再报冲突。
 */
function mergePattern(base, local, remote, resolvedKeys = []) {
  const resolved = new Set(resolvedKeys);
  const merged = local.map((row) => [...row]);
  const conflicts = [];
  for (let row = 0; row < base.length; row += 1) {
    for (let step = 0; step < base[row].length; step += 1) {
      const b = base[row][step];
      const l = local[row][step];
      const r = remote[row][step];
      if (l === r) continue;
      if (l === b) merged[row][step] = r;        // 只有对方改了 → 采纳对方
      else if (r === b) merged[row][step] = l;   // 只有本页改了 → 保留本页
      else if (!resolved.has(cellKey(row, step))) {
        // 同一拍同一乐器被写成不同口令 → 保留本页内容并记录冲突
        merged[row][step] = l;
        conflicts.push({ key: cellKey(row, step), row, step, local: l, remote: r });
      }
    }
  }
  return { merged, conflicts };
}

/** 批注只增合并：按 id 去重后按时间先后排序（新的在前）。 */
function mergeNotes(base, local, remote) {
  const map = new Map();
  [...base, ...remote, ...local].forEach((note) => {
    if (!map.has(note.id)) map.set(note.id, note);
  });
  return [...map.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 合并整个工作稿：格子 + 标量字段 + 批注。 */
function mergeWork(base, local, remote, resolvedKeys = []) {
  const { merged, conflicts } = mergePattern(base.pattern, local.pattern, remote.pattern, resolvedKeys);
  return {
    work: {
      pieceName: local.pieceName !== base.pieceName ? local.pieceName : remote.pieceName,
      bpm: local.bpm !== base.bpm ? local.bpm : remote.bpm,
      loop: local.loop !== base.loop ? local.loop : remote.loop,
      notes: mergeNotes(base.notes, local.notes, remote.notes),
      pattern: merged
    },
    conflicts
  };
}

/* ---------------- 存储层 ---------------- */

function readPlansStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLANS_KEY) || "null");
    if (raw && Array.isArray(raw.plans)) return raw;
  } catch (error) { /* 忽略损坏数据，重建 */ }
  return { plans: [] };
}

function writePlansStore(store) {
  localStorage.setItem(PLANS_KEY, JSON.stringify(store));
}

function readTabsStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) || "null");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  } catch (error) { /* 忽略损坏数据，重建 */ }
  return {};
}

function writeTabsStore(store) {
  localStorage.setItem(TABS_KEY, JSON.stringify(store));
}

function findPlan(store, planId) {
  return store.plans.find((plan) => plan.id === planId) || null;
}

function revisionOf(plan, rev) {
  return plan.revisions.find((item) => item.rev === rev) || null;
}

function headRevision(plan) {
  return revisionOf(plan, plan.head) || plan.revisions[plan.revisions.length - 1] || null;
}

function nextRev(plan) {
  return plan.revisions.reduce((max, item) => Math.max(max, item.rev), 0) + 1;
}

function appendRevision(plan, work, label) {
  const rev = nextRev(plan);
  plan.revisions.push({ rev, at: new Date().toISOString(), label, work: clone(work) });
  plan.head = rev;
  return rev;
}

function makePlan(work) {
  const plan = {
    id: uid(),
    name: work.pieceName || "未命名片段",
    createdAt: new Date().toISOString(),
    head: 0,
    revisions: []
  };
  appendRevision(plan, work, "初始保存");
  return plan;
}

/* ---------------- 会话（每个标签页一份，含未结冲突） ---------------- */

const hasStorage = typeof localStorage !== "undefined" && typeof sessionStorage !== "undefined";

const tabId = !hasStorage ? null : (sessionStorage.getItem("wxyy-4-luogujing-tab") || (() => {
  const id = uid();
  sessionStorage.setItem("wxyy-4-luogujing-tab", id);
  return id;
})());

function normalizeSession(raw) {
  const fallback = { planId: null, baseRev: null, work: defaultWork(), conflicts: [], resolvedKeys: [] };
  if (!raw || typeof raw !== "object") return fallback;
  return {
    planId: raw.planId ?? null,
    baseRev: raw.baseRev ?? null,
    work: normalizeWork(raw.work),
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
    resolvedKeys: Array.isArray(raw.resolvedKeys) ? raw.resolvedKeys : []
  };
}

let plansStore = hasStorage ? readPlansStore() : { plans: [] };
let session = null;

function persist() {
  const tabs = readTabsStore();
  tabs[tabId] = {
    planId: session.planId,
    baseRev: session.baseRev,
    work: session.work,
    conflicts: session.conflicts,
    resolvedKeys: session.resolvedKeys
  };
  writeTabsStore(tabs);
}

/** 把旧版单份存储（wxyy-4-luogujing-grid）迁移进新模型，只执行一次。 */
function migrateLegacy() {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const legacy = JSON.parse(raw);
    (legacy.saved || []).forEach((item) => {
      const plan = makePlan(normalizeWork({
        pieceName: item.name,
        bpm: item.bpm,
        loop: item.loop,
        notes: item.notes,
        pattern: item.pattern
      }));
      plan.createdAt = item.createdAt || plan.createdAt;
      plansStore.plans.push(plan);
    });
    writePlansStore(plansStore);
    if (!readTabsStore()[tabId]) {
      session = normalizeSession({
        planId: null,
        baseRev: null,
        work: {
          pieceName: legacy.pieceName,
          bpm: legacy.bpm,
          loop: legacy.loop,
          notes: legacy.notes,
          pattern: legacy.pattern
        }
      });
      persist();
    }
  } catch (error) { /* 旧数据损坏则跳过迁移 */ }
  localStorage.removeItem(LEGACY_KEY);
}

if (hasStorage && !sessionStorage.getItem("wxyy-4-luogujing-tab-init")) {
  sessionStorage.setItem("wxyy-4-luogujing-tab-init", "1");
  migrateLegacy();
}
session = hasStorage ? normalizeSession(readTabsStore()[tabId]) : normalizeSession(null);

/* ---------------- 运行态 ---------------- */

let timer = null;
let playhead = 0;
let audioContext = null;
let view = null; // { planId, rev, work } 查看旧稿（只读，不持久化）

const unresolved = () => session.conflicts;
const isViewing = () => view !== null;
const activePlan = () => (session.planId ? findPlan(plansStore, session.planId) : null);

/** 当前页面上展示/编辑的工作稿。 */
function currentWork() {
  return view ? view.work : session.work;
}

function conflictsDirty() {
  return unresolved().length > 0;
}

function workDirty() {
  const plan = activePlan();
  if (!plan) return JSON.stringify(defaultWork()) !== JSON.stringify(session.work);
  const head = headRevision(plan);
  return !head || JSON.stringify(head.work) !== JSON.stringify(session.work);
}

/* ---------------- 保存 / 另存 / 恢复 ---------------- */

/**
 * 保存当前方案：在已打开的方案上追加新稿号。
 * 另一方先存过时做三方合并；有冲突则保留本页内容、记录冲突并返回 false。
 */
function commitSave() {
  if (isViewing() || conflictsDirty()) return false;
  plansStore = readPlansStore();
  const plan = findPlan(plansStore, session.planId);
  if (!plan) return forkPlan(); // 方案不见了 → 退化为新方案

  const baseRev = session.baseRev ?? 0;
  if (plan.head > baseRev) {
    const base = revisionOf(plan, baseRev) || plan.revisions[0];
    const remote = headRevision(plan);
    const { work, conflicts } = mergeWork(base.work, session.work, remote.work, session.resolvedKeys);
    session.work = work;
    if (conflicts.length > 0) {
      // 同一拍同一乐器口令不同：保留本页内容，列出冲突；未处理前不能保存/另存
      session.conflicts = conflicts;
      persist();
      return false;
    }
  }

  const rev = appendRevision(plan, session.work, "保存");
  plan.name = session.work.pieceName || plan.name;
  session.baseRev = rev;
  session.conflicts = [];
  session.resolvedKeys = [];
  writePlansStore(plansStore);
  persist();
  return true;
}

/** 另存新方案：以当前内容为稿号1 建一份全新方案。冲突未处理前禁止。 */
function forkPlan() {
  if (isViewing() || conflictsDirty()) return null;
  plansStore = readPlansStore();
  const plan = makePlan(session.work);
  plansStore.plans.unshift(plan);
  writePlansStore(plansStore);
  session.planId = plan.id;
  session.baseRev = plan.head;
  session.conflicts = [];
  session.resolvedKeys = [];
  persist();
  return plan;
}

/** 打开已存方案：带着最新稿号继续编辑。 */
function openPlan(planId) {
  if (conflictsDirty()) {
    window.alert("还有未处理的冲突，请先处理完再切换方案。");
    return;
  }
  const plan = findPlan(plansStore, planId);
  if (!plan) return;
  if (workDirty() && !window.confirm("当前未保存的修改会被丢弃，确定打开另一份方案吗？")) {
    return;
  }
  const head = headRevision(plan);
  view = null;
  session = {
    planId: plan.id,
    baseRev: plan.head,
    work: clone(head.work),
    conflicts: [],
    resolvedKeys: []
  };
  persist();
  render();
}

/** 恢复旧稿：在同一方案下生成新稿号，旧稿仍可查看。 */
function restoreRevision(planId, rev) {
  if (conflictsDirty()) {
    window.alert("还有未处理的冲突，请先处理完再恢复旧稿。");
    return;
  }
  plansStore = readPlansStore();
  const plan = findPlan(plansStore, planId);
  const revision = plan && revisionOf(plan, rev);
  if (!revision) return;
  if (rev === plan.head) {
    openPlan(planId);
    return;
  }
  if (workDirty() && !window.confirm("当前未保存的修改会被丢弃，确定恢复该旧稿吗？")) {
    return;
  }
  const newRev = appendRevision(plan, revision.work, `恢复自稿号${rev}`);
  writePlansStore(plansStore);
  view = null;
  session = {
    planId: plan.id,
    baseRev: newRev,
    work: clone(revision.work),
    conflicts: [],
    resolvedKeys: []
  };
  persist();
  render();
}

/** 查看旧稿（只读）。 */
function viewRevision(planId, rev) {
  const plan = findPlan(plansStore, planId);
  const revision = plan && revisionOf(plan, rev);
  if (!revision) return;
  view = { planId, rev, work: clone(revision.work) };
  render();
}

function exitView() {
  view = null;
  render();
}

/** 处理一条冲突：选本页或选对方。 */
function resolveConflict(key, choice) {
  const conflict = unresolved().find((item) => item.key === key);
  if (!conflict) return;
  const { row, step } = conflict;
  session.work.pattern[row][step] = choice === "remote" ? conflict.remote : conflict.local;
  session.conflicts = unresolved().filter((item) => item.key !== key);
  if (!session.resolvedKeys.includes(key)) session.resolvedKeys.push(key);
  persist();
  render();
}

/* ---------------- DOM ---------------- */

let grid;
let savedList;
let structure;
let notesList;
let pieceName;
let bpmInput;
let loopSelect;
let noteInput;
let saveBtn;
let forkBtn;
let viewBar;
let sessionBar;
let conflictPanel;
let staleHint;

function save() {
  persist();
}

function syncFields() {
  const work = currentWork();
  pieceName.value = work.pieceName;
  bpmInput.value = work.bpm;
  loopSelect.value = work.loop;
}

function renderGrid() {
  if (!grid) return;
  const work = currentWork();
  const conflictKeys = new Set(unresolved().map((item) => item.key));
  const header = ['<div class="label-cell">乐器</div>'];
  for (let i = 0; i < steps; i += 1) {
    header.push(`<div class="beat-cell">${beatLabel(i)}</div>`);
  }

  const rows = instruments.flatMap((instrument, rowIndex) => {
    const row = [`<div class="label-cell">${instrument.name}</div>`];
    for (let step = 0; step < steps; step += 1) {
      const value = work.pattern[rowIndex][step];
      const classes = ["cell"];
      if (value) classes.push("filled");
      if (!view && conflictKeys.has(cellKey(rowIndex, step))) classes.push("conflicted");
      row.push(`<button class="${classes.join(" ")}" type="button" data-row="${rowIndex}" data-step="${step}">${escapeHtml(value)}</button>`);
    }
    return row;
  });

  grid.innerHTML = [...header, ...rows].join("");
}

function renderSidebars() {
  if (!grid) return;
  const work = currentWork();
  const filledByMeasure = [0, 1, 2, 3].map((measure) => {
    const start = measure * 4;
    const count = work.pattern.flatMap((row) => row.slice(start, start + 4)).filter(Boolean).length;
    return { measure: measure + 1, count };
  });
  structure.innerHTML = filledByMeasure.map((item) => `
    <div class="structure-row"><span>第${item.measure}小节</span><strong>${item.count}个口令</strong></div>
  `).join("");

  notesList.innerHTML = work.notes.length ? work.notes.map((note) => `
    <article class="note"><p>${escapeHtml(note.text)}</p><time>${fmtTime(note.at)}</time></article>
  `).join("") : "<p>暂无批注。</p>";

  savedList.innerHTML = plansStore.plans.length ? plansStore.plans.map((plan) => {
    const head = headRevision(plan);
    const editing = session.planId === plan.id && !isViewing();
    const revisions = [...plan.revisions].sort((a, b) => b.rev - a.rev).map((revision) => `
      <div class="rev-row ${revision.rev === plan.head ? "head" : ""}">
        <span>稿号${revision.rev}${revision.rev === plan.head ? "（最新）" : ""} · ${escapeHtml(revision.label)} · ${fmtTime(revision.at)}</span>
        <span class="rev-actions">
          <button type="button" class="link" data-view="${plan.id}:${revision.rev}">查看</button>
          <button type="button" class="link" data-restore="${plan.id}:${revision.rev}">${revision.rev === plan.head ? "打开" : "恢复"}</button>
        </span>
      </div>
    `).join("");
    return `
      <div class="saved-item ${editing ? "editing" : ""}">
        <button class="saved-head" type="button" data-load="${plan.id}">
          <strong>${escapeHtml(plan.name)}</strong><br>
          <span>稿号${plan.head} · ${head ? head.work.bpm : "-"}BPM · ${head ? head.work.notes.length : 0}条批注${editing ? " · 正在编辑" : ""}</span>
        </button>
        <div class="rev-list">${revisions}</div>
      </div>
    `;
  }).join("") : "<p>还没有保存方案。</p>";
}

function renderNotices() {
  if (!grid) return;
  // 查看旧稿提示
  if (isViewing()) {
    const plan = findPlan(plansStore, view.planId);
    viewBar.innerHTML = `
      <span>正在查看「${escapeHtml(plan ? plan.name : "")}」稿号${view.rev}（只读）</span>
      <span class="banner-actions">
        <button type="button" id="restoreViewBtn">恢复此稿为新稿号</button>
        <button type="button" id="exitViewBtn" class="secondary">返回编辑</button>
      </span>
    `;
    viewBar.classList.remove("hidden");
    viewBar.querySelector("#restoreViewBtn").addEventListener("click", () => restoreRevision(view.planId, view.rev));
    viewBar.querySelector("#exitViewBtn").addEventListener("click", exitView);
  } else {
    viewBar.classList.add("hidden");
    viewBar.innerHTML = "";
  }

  // 当前编辑所基于的稿号
  if (!isViewing() && session.planId) {
    const plan = activePlan();
    sessionBar.innerHTML = plan
      ? `<span>正在编辑「${escapeHtml(plan.name)}」 · 基于稿号${session.baseRev}${conflictsDirty() ? " · 有未处理冲突" : ""}</span>`
      : "";
    sessionBar.classList.toggle("hidden", !plan);
  } else {
    sessionBar.classList.add("hidden");
    sessionBar.innerHTML = "";
  }

  // 冲突面板：列出小节、乐器和两边口令
  if (!isViewing() && conflictsDirty()) {
    const items = unresolved().map((conflict) => {
      const { row, step } = conflict;
      const measure = Math.floor(step / 4) + 1;
      return `
        <li class="conflict-item">
          <span>第${measure}小节 第${(step % 4) + 1}拍（${beatLabel(step)}）· ${instruments[row].name}：
            本页「${escapeHtml(conflict.local || "（空）")}」 / 对方「${escapeHtml(conflict.remote || "（空）")}」
          </span>
          <span class="conflict-actions">
            <button type="button" data-resolve="${conflict.key}" data-choice="local">保留本页</button>
            <button type="button" data-resolve="${conflict.key}" data-choice="remote" class="secondary">采用对方</button>
          </span>
        </li>
      `;
    }).join("");
    conflictPanel.innerHTML = `
      <h2>有 ${unresolved().length} 处口令冲突，处理完才能保存或另存新方案</h2>
      <ul>${items}</ul>
    `;
    conflictPanel.classList.remove("hidden");
  } else {
    conflictPanel.classList.add("hidden");
    conflictPanel.innerHTML = "";
  }

  // 对方已先存的提示
  const plan = activePlan();
  const stale = !isViewing() && plan && session.baseRev !== null && plan.head > session.baseRev;
  staleHint.textContent = stale ? `对方已保存到稿号${plan.head}，保存时将自动合并。` : "";
  staleHint.classList.toggle("hidden", !stale);
}

function updateButtons() {
  const blocked = isViewing() || conflictsDirty();
  saveBtn.disabled = blocked;
  forkBtn.disabled = blocked;
  saveBtn.textContent = session.planId ? "保存方案" : "保存为新方案";
  saveBtn.title = conflictsDirty() ? "有未处理的冲突，处理完才能保存" : "";
  forkBtn.title = conflictsDirty() ? "有未处理的冲突，处理完才能另存新方案" : "";
}

function render() {
  if (!grid) return;
  syncFields();
  renderGrid();
  renderSidebars();
  renderNotices();
  updateButtons();
}

/* ---------------- 播放 ---------------- */

function playSound(instrument) {
  audioContext ||= new AudioContext();
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = instrument.freq;
  osc.type = instrument.name === "鼓" ? "sine" : "square";
  gain.gain.setValueAtTime(0.08, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.08);
  osc.connect(gain).connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.09);
}

function highlight(step) {
  document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
  document.querySelectorAll(`[data-step="${step}"]`).forEach((cell) => cell.classList.add("playing"));
}

function currentRange() {
  if (currentWork().loop === "") return [0, steps - 1];
  const start = Number(currentWork().loop) * 4;
  return [start, start + 3];
}

function tick() {
  const [start, end] = currentRange();
  if (playhead < start || playhead > end) playhead = start;
  highlight(playhead);
  instruments.forEach((instrument, rowIndex) => {
    if (currentWork().pattern[rowIndex][playhead]) playSound(instrument);
  });
  playhead = playhead >= end ? start : playhead + 1;
}

/* ---------------- 事件 ---------------- */

function init() {
  grid = document.querySelector("#grid");
  savedList = document.querySelector("#savedList");
  structure = document.querySelector("#structure");
  notesList = document.querySelector("#notesList");
  pieceName = document.querySelector("#pieceName");
  bpmInput = document.querySelector("#bpmInput");
  loopSelect = document.querySelector("#loopSelect");
  noteInput = document.querySelector("#noteInput");
  saveBtn = document.querySelector("#saveBtn");
  forkBtn = document.querySelector("#forkBtn");
  viewBar = document.querySelector("#viewBar");
  sessionBar = document.querySelector("#sessionBar");
  conflictPanel = document.querySelector("#conflictPanel");
  staleHint = document.querySelector("#staleHint");

  grid.addEventListener("click", (event) => {
    if (isViewing()) return;
    const cell = event.target.closest(".cell");
    if (!cell) return;
    const row = Number(cell.dataset.row);
    const step = Number(cell.dataset.step);
    const key = cellKey(row, step);
    session.work.pattern[row][step] = session.work.pattern[row][step] ? "" : instruments[row].token;
    // 手动改冲突格 = 以本页为准处理掉这条冲突
    if (unresolved().some((item) => item.key === key)) {
      session.conflicts = unresolved().filter((item) => item.key !== key);
      if (!session.resolvedKeys.includes(key)) session.resolvedKeys.push(key);
    }
    save();
    render();
  });

  pieceName.addEventListener("input", () => {
    if (isViewing()) return;
    session.work.pieceName = pieceName.value;
    save();
  });

  bpmInput.addEventListener("input", () => {
    if (isViewing()) return;
    session.work.bpm = Number(bpmInput.value || 96);
    save();
    if (timer) {
      clearInterval(timer);
      timer = setInterval(tick, 60000 / session.work.bpm);
    }
  });

  loopSelect.addEventListener("change", () => {
    if (isViewing()) return;
    session.work.loop = loopSelect.value;
    playhead = currentRange()[0];
    save();
  });

  noteInput.addEventListener("keydown", (event) => {
    if (isViewing() || event.key !== "Enter" || !noteInput.value.trim()) return;
    session.work.notes.unshift({ id: uid(), text: noteInput.value.trim(), at: new Date().toISOString() });
    noteInput.value = "";
    save();
    renderSidebars();
  });

  document.querySelector("#playBtn").addEventListener("click", () => {
    if (timer) clearInterval(timer);
    playhead = currentRange()[0];
    tick();
    timer = setInterval(tick, 60000 / currentWork().bpm);
  });

  document.querySelector("#stopBtn").addEventListener("click", () => {
    clearInterval(timer);
    timer = null;
    document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
  });

  saveBtn.addEventListener("click", () => {
    if (conflictsDirty() || isViewing()) return;
    const ok = session.planId ? commitSave() : Boolean(forkPlan());
    if (!ok && conflictsDirty()) {
      window.alert("另一方修改了同一拍，已保留本页内容，请在上方列表中处理冲突。");
    }
    render();
  });

  forkBtn.addEventListener("click", () => {
    if (conflictsDirty() || isViewing()) return;
    forkPlan();
    render();
  });

  conflictPanel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-resolve]");
    if (!button) return;
    resolveConflict(button.dataset.resolve, button.dataset.choice);
  });

  savedList.addEventListener("click", (event) => {
    const viewBtn = event.target.closest("[data-view]");
    if (viewBtn) {
      const [planId, rev] = viewBtn.dataset.view.split(":");
      viewRevision(planId, Number(rev));
      return;
    }
    const restoreBtn = event.target.closest("[data-restore]");
    if (restoreBtn) {
      const [planId, rev] = restoreBtn.dataset.restore.split(":");
      restoreRevision(planId, Number(rev));
      return;
    }
    const loadBtn = event.target.closest("[data-load]");
    if (loadBtn) openPlan(loadBtn.dataset.load);
  });

  // 另一个标签页（排练室另一个人）保存后，刷新本地稿号缓存
  window.addEventListener("storage", (event) => {
    if (event.key === PLANS_KEY) {
      plansStore = readPlansStore();
      renderSidebars();
      renderNotices();
    }
  });

  render();
}

if (typeof document !== "undefined") {
  init();
}

/* 供测试引用 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    mergePattern,
    mergeNotes,
    mergeWork,
    normalizeWork,
    defaultWork,
    emptyPattern,
    beatLabel,
    cellKey,
    commitSave,
    forkPlan,
    openPlan,
    restoreRevision,
    resolveConflict,
    readPlansStore,
    readTabsStore,
    persist,
    __state: () => ({ session, plansStore, tabId }),
    __setWork: (work) => { session.work = normalizeWork(work); }
  };
}
