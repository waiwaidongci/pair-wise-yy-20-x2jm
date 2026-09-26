const storageKey = "wxyy-4-luogujing-grid";
const authorKey = "wxyy-4-luogujing-author";
const instruments = [
  { name: "大锣", token: "仓", freq: 180 },
  { name: "鼓", token: "冬", freq: 120 },
  { name: "钹", token: "才", freq: 360 },
  { name: "小锣", token: "台", freq: 520 }
];
const steps = 16;

let author = sessionStorage.getItem(authorKey);
if (!author) {
  author = `乐师${100 + Math.floor(Math.random() * 900)}`;
  sessionStorage.setItem(authorKey, author);
}

function defaultState() {
  return {
    version: 2,
    pieceName: "出场锣鼓-慢起",
    bpm: 96,
    loop: "",
    notes: [],
    pattern: instruments.map((instrument) =>
      Array.from({ length: steps }, (_, index) => index % 4 === 0 ? instrument.token : "")
    ),
    plans: [],
    // 当前编辑绑定：{ planId, baseRev, basePattern, baseNotes }
    session: null,
    // 查看旧稿时的只读位置：{ planId, rev }
    view: null,
    // 未结的合并冲突（重开后仍在）
    pending: null
  };
}

function nowIso() {
  return new Date().toISOString();
}

function clonePattern(pattern) {
  return pattern.map((row) => [...row]);
}

function cloneNotes(notes) {
  return (notes || []).map((note) => ({ ...note }));
}

// 旧版批注是纯字符串，按"越靠前越新"的旧展示顺序补时间戳并转成时间正序
function migrateNotes(notes, baseTime) {
  if (!Array.isArray(notes)) return [];
  const base = Date.parse(baseTime) || Date.now();
  const migrated = notes.map((note, index) => {
    if (typeof note === "string") {
      return {
        id: crypto.randomUUID(),
        text: note,
        author: "",
        createdAt: new Date(base - (notes.length - 1 - index) * 1000).toISOString()
      };
    }
    return { id: note.id || crypto.randomUUID(), text: note.text, author: note.author || "", createdAt: note.createdAt || baseTime };
  });
  return migrated.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1
  );
}

function migrate(raw) {
  if (!raw) return defaultState();
  if (raw.version === 2) {
    const base = defaultState();
    return { ...base, ...raw, notes: migrateNotes(raw.notes, nowIso()) };
  }
  // v1：每个 saved 快照升级成一个只含第 1 稿的方案
  const plans = (raw.saved || []).map((saved) => ({
    id: saved.id,
    name: saved.name,
    createdAt: saved.createdAt,
    revs: [{
      rev: 1,
      name: saved.name,
      bpm: saved.bpm,
      loop: saved.loop || "",
      notes: migrateNotes(saved.notes, saved.createdAt),
      pattern: clonePattern(saved.pattern),
      createdAt: saved.createdAt,
      author: ""
    }]
  }));
  return {
    ...defaultState(),
    pieceName: raw.pieceName ?? defaultState().pieceName,
    bpm: raw.bpm ?? 96,
    loop: raw.loop ?? "",
    notes: migrateNotes(raw.notes, nowIso()),
    pattern: raw.pattern ? clonePattern(raw.pattern) : defaultState().pattern,
    plans
  };
}

let state = migrate(JSON.parse(localStorage.getItem(storageKey) || "null"));
localStorage.setItem(storageKey, JSON.stringify(state));

// 重开后：未结冲突的合并稿优先恢复；否则恢复只读查看位置
if (state.pending) {
  hydrateFromPending();
  state.view = null;
} else if (state.view) hydrateFromView();

let mode = state.view ? "view" : "edit";
let timer = null;
let playhead = 0;
let audioContext = null;

const grid = document.querySelector("#grid");
const savedList = document.querySelector("#savedList");
const structure = document.querySelector("#structure");
const notesList = document.querySelector("#notesList");
const pieceName = document.querySelector("#pieceName");
const bpmInput = document.querySelector("#bpmInput");
const loopSelect = document.querySelector("#loopSelect");
const noteInput = document.querySelector("#noteInput");
const authorInput = document.querySelector("#authorInput");
const saveBtn = document.querySelector("#saveBtn");
const saveAsBtn = document.querySelector("#saveAsBtn");
const statusLine = document.querySelector("#statusLine");
const conflictPanel = document.querySelector("#conflictPanel");
const viewBanner = document.querySelector("#viewBanner");

authorInput.value = author;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
  );
}

// 只把本页改动的字段写回，并重新读盘以保留另一个标签页刚存入的方案/冲突
function patchStore(patch) {
  const current = JSON.parse(localStorage.getItem(storageKey) || "null") || state;
  const next = { ...current, ...patch };
  localStorage.setItem(storageKey, JSON.stringify(next));
  Object.assign(state, patch);
}

function storedState() {
  return JSON.parse(localStorage.getItem(storageKey) || "null") || state;
}

function findPlan(plans, planId) {
  return plans.find((plan) => plan.id === planId) || null;
}

function findRev(plan, rev) {
  return plan.revs.find((entry) => entry.rev === rev) || null;
}

function headRev(plan) {
  return plan.revs[plan.revs.length - 1];
}

function loadIntoFields(rev) {
  state.pieceName = rev.name;
  state.bpm = rev.bpm;
  state.loop = rev.loop || "";
  state.notes = cloneNotes(rev.notes);
  state.pattern = clonePattern(rev.pattern);
}

function editorContent() {
  return {
    name: state.pieceName,
    bpm: state.bpm,
    loop: state.loop,
    notes: cloneNotes(state.notes),
    pattern: clonePattern(state.pattern)
  };
}

function hydrateFromPending() {
  const pending = state.pending;
  state.pieceName = pending.pieceName;
  state.bpm = pending.bpm;
  state.loop = pending.loop;
  state.notes = cloneNotes(pending.notes);
  state.pattern = clonePattern(pending.pattern);
}

function hydrateFromView() {
  const plan = findPlan(state.plans, state.view.planId);
  if (!plan) {
    state.view = null;
    return;
  }
  const rev = findRev(plan, state.view.rev) || headRev(plan);
  state.view = { planId: plan.id, rev: rev.rev };
  loadIntoFields(rev);
}

// 编辑区有改动时：同步进未结冲突快照，保证重开后仍是同一份合并稿
function persistDraft() {
  const patch = {
    pieceName: state.pieceName,
    bpm: state.bpm,
    loop: state.loop,
    notes: cloneNotes(state.notes),
    pattern: clonePattern(state.pattern)
  };
  if (state.pending) {
    Object.assign(state.pending, {
      pieceName: state.pieceName,
      bpm: state.bpm,
      loop: state.loop,
      notes: cloneNotes(state.notes),
      pattern: clonePattern(state.pattern)
    });
    patch.pending = state.pending;
  }
  patchStore(patch);
}

function syncFields() {
  pieceName.value = state.pieceName;
  bpmInput.value = state.bpm;
  loopSelect.value = state.loop;
  authorInput.value = author;
}

function beatLabel(index) {
  const measure = Math.floor(index / 4) + 1;
  const beat = (index % 4) + 1;
  return `${measure}-${beat}`;
}

function conflictAt(row, step) {
  if (!state.pending) return null;
  return state.pending.conflicts.find((item) => item.row === row && item.step === step) || null;
}

function allConflictsDecided() {
  return !!state.pending && state.pending.conflicts.length > 0 &&
    state.pending.conflicts.every((item) => item.decided);
}

function renderGrid() {
  const header = ['<div class="label-cell">乐器</div>'];
  for (let i = 0; i < steps; i += 1) {
    header.push(`<div class="beat-cell">${beatLabel(i)}</div>`);
  }

  const rows = instruments.flatMap((instrument, rowIndex) => {
    const row = [`<div class="label-cell">${instrument.name}</div>`];
    for (let step = 0; step < steps; step += 1) {
      const value = state.pattern[rowIndex][step];
      const conflict = conflictAt(rowIndex, step);
      const classes = ["cell"];
      if (value) classes.push("filled");
      if (conflict) classes.push(conflict.decided ? "resolved" : "conflict");
      const disabled = mode === "view" ? " disabled" : "";
      row.push(
        `<button class="${classes.join(" ")}" type="button" data-row="${rowIndex}" data-step="${step}"${disabled}>${value}</button>`
      );
    }
    return row;
  });

  grid.innerHTML = [...header, ...rows].join("");
}

function fmtTime(iso) {
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderSidebars() {
  const filledByMeasure = [0, 1, 2, 3].map((measure) => {
    const start = measure * 4;
    const count = state.pattern.flatMap((row) => row.slice(start, start + 4)).filter(Boolean).length;
    return { measure: measure + 1, count };
  });
  structure.innerHTML = filledByMeasure.map((item) => `
    <div class="structure-row"><span>第${item.measure}小节</span><strong>${item.count}个口令</strong></div>
  `).join("");

  const notes = [...state.notes].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1
  );
  notesList.innerHTML = notes.length ? notes.map((note) => `
    <article class="note">
      <p>${esc(note.text)}</p>
      <footer>${esc(note.author || "未署名")} · ${fmtTime(note.createdAt)}</footer>
    </article>
  `).join("") : "<p>暂无批注。</p>";

  // 方案历史始终以磁盘最新为准，避免本页旧列表把另一方刚存的稿号冲掉
  const plans = storedState().plans;
  savedList.innerHTML = plans.length ? plans.map((plan) => {
    const head = headRev(plan);
    const revRows = [...plan.revs].reverse().map((rev) => `
      <div class="rev-row">
        <span class="rev-meta">第${rev.rev}稿<em>${fmtTime(rev.createdAt)}${rev.author ? ` · ${esc(rev.author)}` : ""}</em></span>
        <span class="rev-actions">
          <button class="mini" type="button" data-view="${plan.id}:${rev.rev}">查看</button>
          ${rev.rev !== head.rev ? `<button class="mini ghost" type="button" data-restore="${plan.id}:${rev.rev}">恢复</button>` : ""}
        </span>
      </div>
    `).join("");
    return `
      <div class="saved-item plan-card">
        <button class="plan-open" type="button" data-open="${plan.id}">
          <strong>${esc(plan.name)}</strong>
          <span>最新第${head.rev}稿 · 共${plan.revs.length}稿 · ${head.notes.length}条批注</span>
        </button>
        <details class="rev-history">
          <summary>稿号历史</summary>
          ${revRows}
        </details>
      </div>
    `;
  }).join("") : "<p>还没有保存方案。</p>";
}

// 批注合并：本应用只能添加批注，取并集后按添加先后排序
function mergeNotes(baseNotes, oursNotes, theirsNotes) {
  const byId = new Map();
  [...baseNotes, ...oursNotes, ...theirsNotes].forEach((note) => {
    if (!byId.has(note.id)) byId.set(note.id, note);
  });
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1
  );
}

// 三方合并：基底稿 / 本页 / 对方先存的新稿
function merge3way(basePattern, baseNotes, ours, theirs) {
  const pattern = clonePattern(ours.pattern);
  const conflicts = [];
  for (let row = 0; row < instruments.length; row += 1) {
    for (let step = 0; step < steps; step += 1) {
      const baseValue = basePattern[row][step];
      const oursValue = ours.pattern[row][step];
      const theirsValue = theirs.pattern[row][step];
      if (oursValue === baseValue) {
        pattern[row][step] = theirsValue;
      } else if (theirsValue === baseValue || oursValue === theirsValue) {
        pattern[row][step] = oursValue;
      } else {
        // 同一拍同一乐器被写成不同口令：保留本页内容，登记冲突
        pattern[row][step] = oursValue;
        conflicts.push({ row, step, ours: oursValue, theirs: theirsValue });
      }
    }
  }
  return { pattern, notes: mergeNotes(baseNotes, ours.notes, theirs.notes), conflicts };
}

function commandLabel(value) {
  return value || "空拍";
}

function renderConflicts() {
  const pending = state.pending;
  if (!pending) {
    conflictPanel.hidden = true;
    conflictPanel.innerHTML = "";
    return;
  }
  const peer = pending.peerAuthor || "先存的一方";
  const items = pending.conflicts.map((item, index) => {
    const measure = Math.floor(item.step / 4) + 1;
    const beat = (item.step % 4) + 1;
    return `
      <li class="conflict-item ${item.decided ? "decided" : ""}">
        <div class="conflict-meta">第${measure}小节第${beat}拍 · ${instruments[item.row].name}</div>
        <div class="conflict-choices">
          <button type="button" class="mini ${item.decided && item.choice === "ours" ? "pick" : ""}"
            data-conflict="${index}" data-choice="ours">本页（${esc(author)}）：${esc(commandLabel(item.ours))}</button>
          <button type="button" class="mini ${item.decided && item.choice === "theirs" ? "pick" : ""}"
            data-conflict="${index}" data-choice="theirs">对方（${esc(peer)}）：${esc(commandLabel(item.theirs))}</button>
        </div>
      </li>
    `;
  }).join("");
  conflictPanel.innerHTML = `
    <h3>合并冲突${allConflictsDecided() ? "（已全部处理）" : ""}</h3>
    <p class="conflict-intro">
      对方已先存入第${pending.mergedFromRev}稿（本页打开时是第${pending.openedRev}稿）。
      不同位置的口令已自动合并；下列同一拍同一乐器两边口令不同，已先保留本页内容，逐条选择后才能保存。
    </p>
    <ul>${items}</ul>
  `;
  conflictPanel.hidden = false;
}

function renderViewBanner() {
  if (mode !== "view" || !state.view) {
    viewBanner.hidden = true;
    viewBanner.innerHTML = "";
    return;
  }
  const plan = findPlan(storedState().plans, state.view.planId);
  const name = plan ? plan.name : "方案";
  viewBanner.innerHTML = `
    <span>正在只读查看《${esc(name)}》第${state.view.rev}稿，旧稿始终保留可查。</span>
    <button type="button" id="restoreViewBtn">恢复此稿（保存时生成新稿号）</button>
    <button type="button" class="ghost" id="backEditBtn">返回编辑</button>
  `;
  viewBanner.hidden = false;
}

function setStatus(text) {
  statusLine.textContent = text;
}

function updateChrome() {
  const blocked = !!state.pending;
  const decided = allConflictsDecided();
  saveBtn.disabled = mode === "view" || (blocked && !decided);
  saveAsBtn.disabled = mode === "view" || (blocked && !decided);

  if (state.pending) {
    saveBtn.textContent = decided ? "保存合并稿（生成新稿号）" : `有 ${state.pending.conflicts.filter((c) => !c.decided).length} 处冲突待处理`;
    setStatus(decided
      ? "冲突已全部处理，可以保存合并稿。"
      : `与对方第${state.pending.mergedFromRev}稿有 ${state.pending.conflicts.length} 处口令冲突，处理完之前不能保存或另存新方案。`);
  } else if (mode === "view" && state.view) {
    saveBtn.textContent = "只读查看中";
    setStatus(`正在查看第${state.view.rev}稿（只读），需要修改请先恢复此稿。`);
  } else if (state.session) {
    const plan = findPlan(storedState().plans, state.session.planId);
    const head = plan ? headRev(plan) : null;
    saveBtn.textContent = head && head.rev > state.session.baseRev
      ? `保存（合并对方第${head.rev}稿）`
      : "保存（生成新稿号）";
    if (head && head.rev > state.session.baseRev) {
      setStatus(`正在编辑《${plan.name}》，本页基于第${state.session.baseRev}稿；对方已先存第${head.rev}稿，保存时自动合并。`);
    } else if (plan) {
      setStatus(`正在编辑《${plan.name}》，打开时稿号：第${state.session.baseRev}稿。`);
    } else {
      setStatus("正在编辑。");
    }
  } else {
    saveBtn.textContent = "保存为新方案";
    setStatus("这是一份尚未保存的新方案，保存后生成第 1 稿。");
  }

  pieceName.disabled = bpmInput.disabled = loopSelect.disabled = noteInput.disabled = mode === "view";
  renderViewBanner();
}

function render() {
  syncFields();
  renderGrid();
  renderSidebars();
  renderConflicts();
  updateChrome();
}

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
  if (state.loop === "") return [0, steps - 1];
  const start = Number(state.loop) * 4;
  return [start, start + 3];
}

function tick() {
  const [start, end] = currentRange();
  if (playhead < start || playhead > end) playhead = start;
  highlight(playhead);
  instruments.forEach((instrument, rowIndex) => {
    if (state.pattern[rowIndex][playhead]) playSound(instrument);
  });
  playhead = playhead >= end ? start : playhead + 1;
}

function blockedByPending() {
  if (state.pending) {
    setStatus("请先处理完本页的合并冲突，再打开或恢复其他稿。");
    return true;
  }
  return false;
}

grid.addEventListener("click", (event) => {
  const cell = event.target.closest(".cell");
  if (!cell || mode === "view") return;
  const row = Number(cell.dataset.row);
  const step = Number(cell.dataset.step);
  if (conflictAt(row, step)) {
    setStatus("这一拍存在冲突，请在下方冲突清单里选择保留哪一边。");
    return;
  }
  state.pattern[row][step] = state.pattern[row][step] ? "" : instruments[row].token;
  persistDraft();
  render();
});

pieceName.addEventListener("input", () => {
  state.pieceName = pieceName.value;
  persistDraft();
});

bpmInput.addEventListener("input", () => {
  state.bpm = Number(bpmInput.value || 96);
  persistDraft();
  if (timer) {
    clearInterval(timer);
    timer = setInterval(tick, 60000 / state.bpm);
  }
});

loopSelect.addEventListener("change", () => {
  state.loop = loopSelect.value;
  playhead = currentRange()[0];
  persistDraft();
});

noteInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !noteInput.value.trim() || mode === "view") return;
  state.notes.push({
    id: crypto.randomUUID(),
    text: noteInput.value.trim(),
    author,
    createdAt: nowIso()
  });
  noteInput.value = "";
  persistDraft();
  render();
});

authorInput.addEventListener("input", () => {
  author = authorInput.value.trim() || "未署名";
  sessionStorage.setItem(authorKey, author);
  renderConflicts();
  updateChrome();
});

document.querySelector("#playBtn").addEventListener("click", () => {
  if (timer) clearInterval(timer);
  playhead = currentRange()[0];
  tick();
  timer = setInterval(tick, 60000 / state.bpm);
});

document.querySelector("#stopBtn").addEventListener("click", () => {
  clearInterval(timer);
  timer = null;
  document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
});

function enterConflict(plan, head, merged, openedRev) {
  state.pending = {
    planId: plan.id,
    planName: plan.name,
    openedRev,
    mergedFromRev: head.rev,
    basePattern: clonePattern(head.pattern),
    baseNotes: cloneNotes(head.notes),
    peerAuthor: head.author || "",
    pieceName: state.pieceName,
    bpm: state.bpm,
    loop: state.loop,
    notes: merged.notes,
    pattern: merged.pattern,
    conflicts: merged.conflicts.map((item) => ({ ...item, decided: false, choice: "ours" })),
    createdAt: nowIso()
  };
  hydrateFromPending();
  patchStore({
    pending: state.pending,
    pieceName: state.pieceName,
    bpm: state.bpm,
    loop: state.loop,
    notes: cloneNotes(state.notes),
    pattern: clonePattern(state.pattern)
  });
  mode = "edit";
  render();
}

function commitRevision(plans, plan, merged) {
  const head = headRev(plan);
  const revision = {
    rev: head.rev + 1,
    name: state.pieceName || "未命名片段",
    bpm: state.bpm,
    loop: state.loop,
    notes: merged.notes,
    pattern: merged.pattern,
    createdAt: nowIso(),
    author
  };
  plan.revs.push(revision);
  plan.name = revision.name;
  state.session = {
    planId: plan.id,
    baseRev: revision.rev,
    basePattern: clonePattern(revision.pattern),
    baseNotes: cloneNotes(revision.notes)
  };
  state.pending = null;
  state.view = null;
  patchStore({
    plans,
    session: state.session,
    pending: null,
    view: null,
    pieceName: revision.name,
    bpm: revision.bpm,
    loop: revision.loop,
    notes: cloneNotes(revision.notes),
    pattern: clonePattern(revision.pattern)
  });
  mode = "edit";
  setStatus(`已保存：《${revision.name}》第${revision.rev}稿。`);
  render();
}

function createPlan() {
  if (blockedByPending()) return;
  const plans = storedState().plans;
  const plan = {
    id: crypto.randomUUID(),
    name: state.pieceName || "未命名片段",
    createdAt: nowIso(),
    revs: [{
      rev: 1,
      name: state.pieceName || "未命名片段",
      bpm: state.bpm,
      loop: state.loop,
      notes: cloneNotes(state.notes),
      pattern: clonePattern(state.pattern),
      createdAt: nowIso(),
      author
    }]
  };
  plans.unshift(plan);
  state.session = {
    planId: plan.id,
    baseRev: 1,
    basePattern: clonePattern(plan.revs[0].pattern),
    baseNotes: cloneNotes(plan.revs[0].notes)
  };
  state.pending = null;
  state.view = null;
  patchStore({
    plans,
    session: state.session,
    pending: null,
    view: null,
    pieceName: plan.name,
    bpm: state.bpm,
    loop: state.loop,
    notes: cloneNotes(state.notes),
    pattern: clonePattern(state.pattern)
  });
  mode = "edit";
  setStatus(`已另存为新方案《${plan.name}》第 1 稿。`);
  render();
}

// 保存：带着打开时的稿号；对方先存就三方合并，遇冲突挂起等待处理
function saveCurrent() {
  if (mode === "view") return;
  if (state.pending && !allConflictsDecided()) {
    setStatus("冲突没有处理完，不能保存或另存新方案。");
    return;
  }

  const plans = storedState().plans;
  const binding = state.pending || state.session;
  const plan = binding ? findPlan(plans, binding.planId) : null;

  if (!plan) {
    createPlan();
    return;
  }

  const head = headRev(plan);
  const ours = editorContent();
  let baseRev;
  let basePattern;
  let baseNotes;
  if (state.pending) {
    baseRev = state.pending.mergedFromRev;
    basePattern = state.pending.basePattern;
    baseNotes = state.pending.baseNotes;
  } else {
    const base = findRev(plan, state.session.baseRev) || head;
    baseRev = base.rev;
    basePattern = base.pattern;
    baseNotes = base.notes;
  }

  const merged = head.rev === baseRev
    ? { pattern: ours.pattern, notes: ours.notes, conflicts: [] }
    : merge3way(basePattern, baseNotes, ours, head);

  if (merged.conflicts.length) {
    const openedRev = state.pending ? state.pending.openedRev : state.session.baseRev;
    enterConflict(plan, head, merged, openedRev);
    return;
  }

  commitRevision(plans, plan, merged);
}

saveBtn.addEventListener("click", saveCurrent);
saveAsBtn.addEventListener("click", createPlan);

conflictPanel.addEventListener("click", (event) => {
  const button = event.target.closest("[data-conflict]");
  if (!button) return;
  const index = Number(button.dataset.conflict);
  const choice = button.dataset.choice;
  const item = state.pending.conflicts[index];
  item.decided = true;
  item.choice = choice;
  state.pattern[item.row][item.step] = choice === "ours" ? item.ours : item.theirs;
  persistDraft();
  render();
});

function openHead(planId) {
  if (blockedByPending()) return;
  const plan = findPlan(storedState().plans, planId);
  if (!plan) return;
  const head = headRev(plan);
  loadIntoFields(head);
  state.session = {
    planId: plan.id,
    baseRev: head.rev,
    basePattern: clonePattern(head.pattern),
    baseNotes: cloneNotes(head.notes)
  };
  state.view = null;
  patchStore({
    session: state.session,
    view: null,
    pieceName: state.pieceName,
    bpm: state.bpm,
    loop: state.loop,
    notes: cloneNotes(state.notes),
    pattern: clonePattern(state.pattern)
  });
  mode = "edit";
  render();
}

function openRevisionView(planId, rev) {
  if (blockedByPending()) return;
  const plan = findPlan(storedState().plans, planId);
  if (!plan) return;
  const revision = findRev(plan, rev);
  if (!revision) return;
  loadIntoFields(revision);
  state.view = { planId, rev: revision.rev };
  patchStore({
    view: state.view,
    pieceName: state.pieceName,
    bpm: state.bpm,
    loop: state.loop,
    notes: cloneNotes(state.notes),
    pattern: clonePattern(state.pattern)
  });
  mode = "view";
  render();
}

// 恢复旧稿：以当前最新稿为合并基底，旧稿内容作为本页改动，保存后得到新稿号
function restoreRevision(planId, rev) {
  if (blockedByPending()) return;
  const plans = storedState().plans;
  const plan = findPlan(plans, planId);
  if (!plan) return;
  const revision = findRev(plan, rev);
  if (!revision) return;
  const head = headRev(plan);
  loadIntoFields(revision);
  state.session = {
    planId: plan.id,
    baseRev: head.rev,
    basePattern: clonePattern(head.pattern),
    baseNotes: cloneNotes(head.notes)
  };
  state.view = null;
  patchStore({
    session: state.session,
    view: null,
    pieceName: state.pieceName,
    bpm: state.bpm,
    loop: state.loop,
    notes: cloneNotes(state.notes),
    pattern: clonePattern(state.pattern)
  });
  mode = "edit";
  setStatus(`已调出第${revision.rev}稿内容，保存后将在最新第${head.rev}稿之后生成新稿号，旧稿保留。`);
  render();
}

function backToEditing() {
  if (!state.view) return;
  const viewedPlanId = state.view.planId;
  const plan = findPlan(storedState().plans, viewedPlanId);
  state.view = null;
  if (plan) {
    const head = headRev(plan);
    loadIntoFields(head);
    state.session = {
      planId: plan.id,
      baseRev: head.rev,
      basePattern: clonePattern(head.pattern),
      baseNotes: cloneNotes(head.notes)
    };
  }
  patchStore({
    view: null,
    session: state.session,
    pieceName: state.pieceName,
    bpm: state.bpm,
    loop: state.loop,
    notes: cloneNotes(state.notes),
    pattern: clonePattern(state.pattern)
  });
  mode = "edit";
  render();
}

savedList.addEventListener("click", (event) => {
  const openButton = event.target.closest("[data-open]");
  if (openButton) {
    openHead(openButton.dataset.open);
    return;
  }
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    const [planId, rev] = viewButton.dataset.view.split(":");
    openRevisionView(planId, Number(rev));
    return;
  }
  const restoreButton = event.target.closest("[data-restore]");
  if (restoreButton) {
    const [planId, rev] = restoreButton.dataset.restore.split(":");
    restoreRevision(planId, Number(rev));
  }
});

viewBanner.addEventListener("click", (event) => {
  if (event.target.closest("#restoreViewBtn") && state.view) {
    restoreRevision(state.view.planId, state.view.rev);
  } else if (event.target.closest("#backEditBtn")) {
    backToEditing();
  }
});

// 另一个标签页（排练室的另一方）先存时，刷新稿号历史与状态提示
window.addEventListener("storage", (event) => {
  if (event.key !== storageKey || !event.newValue) return;
  const fresh = JSON.parse(event.newValue);
  state.plans = fresh.plans || [];
  renderSidebars();
  updateChrome();
});

render();
