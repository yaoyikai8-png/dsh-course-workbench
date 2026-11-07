/**
 * Smoke test for the client half without a browser: stub the module loader,
 * React, and the Cordis client context, then run apply() and render the panel
 * twice — once loading, once with fetched data.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve against this file so the test runs from any checkout location.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'client.js'), 'utf8');

let registration;
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg;
    },
  },
};

// Minimal React stand-in: createElement builds plain trees; state survives
// across the two render passes below so the fetched data path also renders.
const stateSlots = [];
const effects = [];
let stateCursor = 0;
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() };
  },
  useState(initial) {
    const index = stateCursor++;
    if (!(index in stateSlots)) stateSlots[index] = initial;
    return [
      stateSlots[index],
      (next) => {
        stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next;
      },
    ];
  },
  useEffect(fn) {
    effects.push(fn);
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
  Fragment: 'Fragment',
};

const registered = [];
const openedSessions = [];
const openedResources = [];
const renamed = [];
const sentPrompts = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject(deps, cb) {
    const scoped = {};
    if (deps.includes('sidebarRight')) {
      scoped.sidebarRight = { openResource: (address) => openedResources.push(address) };
    }
    if (deps.includes('uiWorkspace')) {
      scoped.uiWorkspace = {
        openWorkspace: async () => {},
        openSession: (id) => openedSessions.push(id),
        connectWorkspace: async () => 'session-new',
        startSession: () => {},
      };
    }
    if (deps.includes('workspaces')) {
      scoped.workspaces = { create: async () => ({ workspaceId: 'ws-new' }) };
    }
    if (deps.includes('sessions')) {
      // A freshly created Session has no borrowed binding — only `using`
      // retains one. Mirror that, so the test fails if the code regresses to
      // `binding()` on a brand-new Session.
      const makeBinding = (id) => ({
        sessionId: id,
        session: {
          prompt: async (content) => {
            sentPrompts.push({ id, text: content[0].text });
            return { ok: true };
          },
          rename: async (title) => {
            renamed.push({ id, title });
            return { ok: true };
          },
        },
      });
      scoped.sessions = {
        list: { getSnapshot: () => ({ byId: {}, ids: [] }) },
        binding: () => undefined,
        using: async (id, options, operation) => {
          const binding = makeBinding(id);
          return operation({
            sessionId: id,
            ready: Promise.resolve(binding),
            binding,
            release() {},
          });
        },
      };
    }
    cb(scoped);
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => `[${key}]`,
    getSnapshot: () => ({ active: 'zh', locales: [], revision: 1 }),
  },
  slots: {
    inject(key, cb) {
      const effect = cb();
      registered.push({ key, effect });
      return () => {};
    },
    register(definition, render) {
      registered.push({ definition, render });
      return () => {};
    },
  },
};

const overviewPayload = {
  ok: true,
  root: 'C:\\courses',
  roots: [
    { path: 'C:\\courses', removable: false },
    { path: 'C:\\courses-extra', removable: true },
  ],
  generatedAt: '2026-11-07T00:00:00.000Z',
  courses: [
      {
        name: '测试课程',
        path: 'C:\\courses\\测试课程',
        courseFileCount: 3,
        files: [
          {
            name: '第1讲.pptx',
            path: 'C:\\courses\\测试课程\\第1讲.pptx',
            dir: '',
            ext: 'pptx',
            mtime: '2026-11-01T00:00:00.000Z',
            sizeKB: 120,
          },
          {
            name: '讲义.pdf',
            path: 'C:\\courses\\测试课程\\课件\\讲义.pdf',
            dir: '课件',
            ext: 'pdf',
            mtime: '2026-11-02T00:00:00.000Z',
            sizeKB: 340,
          },
        ],
        subfolders: [{ name: '课件', files: 2 }],
        notes: [
          {
            name: '第1讲-知识点笔记.md',
            path: 'C:\\courses\\测试课程\\笔记\\第1讲-知识点笔记.md',
            dir: '笔记',
            mtime: '2026-11-05T00:00:00.000Z',
            sizeKB: 12,
          },
        ],
        latestFiles: [{ name: '第1讲.pptx', mtime: '2026-11-01T00:00:00.000Z', sizeKB: 120 }],
        lastModified: '2026-11-01T00:00:00.000Z',
        workspaceId: 'ws-1',
        sessionId: 'session-1',
      },
      {
        name: '空课程',
        path: 'C:\\courses\\空课程',
        courseFileCount: 0,
        files: [],
        subfolders: [],
        latestFiles: [],
        lastModified: '',
      },
  ],
};

const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  fetchCalls.push({ url: target, init });
  if (target.includes('/note-chat')) {
    const created = init !== undefined && init.method === 'POST';
    return {
      ok: true,
      json: async () => ({ ok: true, sessionId: created ? 'session-new' : null, notePath: '' }),
    };
  }
  return { ok: true, json: async () => overviewPayload };
};

// Evaluate the bundle: it must call window.__ModuleLoader__.load exactly once.
new Function('window', source)(globalThis.window);
if (registration === undefined) throw new Error('module did not register with the loader');
if (registration.id !== 'tongji-course-workbench') {
  throw new Error(`unexpected id ${registration.id}`);
}

const mod = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected external ${specifier}`);
});
if (typeof mod.apply !== 'function') throw new Error('module has no apply()');
if (!Array.isArray(mod.inject) || !mod.inject.includes('slots')) {
  throw new Error('module does not inject slots');
}

mod.apply(ctx);

﻿const mains = registered.filter((item) => item.definition && item.definition.name === 'main');
const sidebars = registered.filter(
  (item) => item.definition && item.definition.name === 'sidebar.panellist',
);
if (mains.length !== 1) throw new Error(`expected exactly one main panel, got ${mains.length}`);
if (sidebars.length !== 1) throw new Error(`expected exactly one sidebar entry, got ${sidebars.length}`);
const courseMain = mains[0];
const courseIcon = sidebars[0];
if (courseMain.definition.key !== 'course-workbench') throw new Error('wrong main key');
if (courseIcon.definition.id !== 'course-workbench') throw new Error('wrong sidebar id');

// Expand function components the way React would before inspecting the tree.
// Results are memoised per element object so one render pass calls a component
// exactly once — otherwise every re-walk would consume fresh state slots.
const expandedCache = new WeakMap();
const expand = (node) => {
  if (
    node &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    typeof node.type === 'function'
  ) {
    if (expandedCache.has(node)) return expandedCache.get(node);
    const result = expand(node.type(node.props || {}));
    expandedCache.set(node, result);
    return result;
  }
  return node;
};

const walk = (node, texts) => {
  const expanded = expand(node);
  if (expanded === null || expanded === undefined || expanded === false) return;
  if (typeof expanded === 'string' || typeof expanded === 'number') {
    texts.push(String(expanded));
    return;
  }
  if (Array.isArray(expanded)) {
    expanded.forEach((child) => walk(child, texts));
    return;
  }
  if (typeof expanded === 'object' && expanded.children) {
    expanded.children.forEach((child) => walk(child, texts));
  }
};

/** Deepest node of `type` whose text content contains `needle`. */
const findByText = (node, needle, type = 'button', index = -1) => {
  const hits = [];
  const visit = (current) => {
    const expanded = expand(current);
    if (expanded === null || expanded === undefined || expanded === false) return;
    if (Array.isArray(expanded)) {
      expanded.forEach(visit);
      return;
    }
    if (typeof expanded !== 'object' || !expanded.children) return;
    const texts = [];
    walk(expanded, texts);
    if (expanded.type === type && texts.join('').includes(needle)) hits.push(expanded);
    expanded.children.forEach(visit);
  };
  visit(node);
  if (hits.length === 0) return undefined;
  return hits[index < 0 ? hits.length + index : index];
};

/** Render one panel through its loading pass, its effect, and its data pass. */
const renderPanel = async (entry) => {
  stateSlots.length = 0;
  effects.length = 0;
  stateCursor = 0;
  const first = expand(entry.render({}));
  if (!first) throw new Error(`${entry.definition.key}: render returned nothing`);
  effects.forEach((effect) => effect());
  await new Promise((resolve) => setTimeout(resolve, 20));
  stateCursor = 0;
  const tree = expand(entry.render({}));
  const texts = [];
  walk(tree, texts);
  return { text: texts.join(' / '), tree };
};

const icon = expand(courseIcon.render({ size: 16, active: false }));
if (!icon || icon.type !== 'svg') throw new Error('sidebar icon did not render an svg');

const list = await renderPanel(courseMain);
if (!list.text.includes('测试课程')) throw new Error('course card did not render the course name');
if (!list.text.includes('空课程')) throw new Error('second course card missing');
if (!list.text.includes('C:\\courses-extra')) {
  throw new Error('course list did not render the extra course root');
}
if (!list.text.includes('[openCourseware]')) {
  throw new Error('course with a live session did not offer "open courseware"');
}
if (!list.text.includes('[createProject]')) {
  throw new Error('course without a project did not offer "new project"');
}

// Switch to the Notes tab: courses are listed with their note counts.
const notesTab = findByText(list.tree, '[tabNotes]');
if (notesTab === undefined) throw new Error('notes tab button not found');
notesTab.props.onClick();
stateCursor = 0;
let notesTree = expand(courseMain.render({}));
let notesTexts = [];
walk(notesTree, notesTexts);
if (!notesTexts.join(' / ').includes('[noteCount]')) {
  throw new Error('notes view did not render per-course note counts');
}

// Expanding a course reveals its generated notes.
const courseHead = findByText(notesTree, '测试课程', 'div');
if (courseHead === undefined) throw new Error('notes view course row not found');
courseHead.props.onClick();
stateCursor = 0;
notesTree = expand(courseMain.render({}));
notesTexts = [];
walk(notesTree, notesTexts);
const notesText = notesTexts.join(' / ');
if (!notesText.includes('第1讲-知识点笔记.md')) {
  throw new Error('expanded course did not list its notes');
}
if (!notesText.includes('笔记')) throw new Error('note row did not show its folder tag');

// The Q&A button creates a Session on demand and sends the note path first.
const askButton = findByText(notesTree, '[askNote]');
if (askButton === undefined) throw new Error('note row has no ask button');
askButton.props.onClick({ stopPropagation() {} });
await new Promise((resolve) => setTimeout(resolve, 40));
if (sentPrompts.length !== 1) {
  throw new Error(`expected one opening prompt, got ${sentPrompts.length}`);
}
if (!sentPrompts[0].text.includes('第1讲-知识点笔记.md')) {
  throw new Error('opening prompt did not name the note');
}
if (openedSessions[0] !== 'session-new') {
  throw new Error(`ask did not open the new session (got ${openedSessions[0]})`);
}
if (!fetchCalls.some((call) => call.init !== undefined && call.init.method === 'POST')) {
  throw new Error('ask did not persist the note conversation mapping');
}
if (!openedResources.some((address) => address.includes(encodeURIComponent('第1讲-知识点笔记.md')))) {
  throw new Error('ask did not open the note preview on the right');
}
if (!renamed.some((entry) => entry.title.includes('笔记问答'))) {
  throw new Error('ask did not name the Q&A conversation');
}

// Back to the course list, then open the exam-review view for the same course.
const coursesTab = findByText(notesTree, '[tabCourses]');
if (coursesTab === undefined) throw new Error('courses tab button not found');
coursesTab.props.onClick();
stateCursor = 0;
const listAgain = expand(courseMain.render({}));

const reviewButton = findByText(listAgain, '[review]', 'button', 0);
if (reviewButton === undefined) throw new Error('course card has no review button');
reviewButton.props.onClick();
stateCursor = 0;
const reviewTree = expand(courseMain.render({}));
const reviewTexts = [];
walk(reviewTree, reviewTexts);
const reviewText = reviewTexts.join(' / ');
if (!reviewText.includes('[reviewBody]')) throw new Error('review view did not explain the deliverable');
if (!reviewText.includes('[generateReview]')) throw new Error('review view has no generate button');
if (!reviewText.includes('第1讲.pptx')) throw new Error('review view did not list the files');
if (reviewText.includes('[formatDocx]')) throw new Error('review view still offers a Word output');

const backButton = findByText(reviewTree, '[back]');
if (backButton === undefined) throw new Error('review view has no way back');
backButton.props.onClick();
stateCursor = 0;
const listOnceMore = expand(courseMain.render({}));

// Click "打开课件" on the course that already has a session: the same panel must
// switch to that course's file list instead of navigating away.
const openButton = findByText(listOnceMore, '[openCourseware]');
if (openButton === undefined) throw new Error('open-courseware button not found in the tree');
openButton.props.onClick();
stateCursor = 0;
const courseware = expand(courseMain.render({}));
const cwTexts = [];
walk(courseware, cwTexts);
const cwText = cwTexts.join(' / ');
if (!cwText.includes('第1讲.pptx')) throw new Error('courseware view did not list the files');
if (!cwText.includes('讲义.pdf')) throw new Error('courseware view missed a nested file');
if (!cwText.includes('[generate]')) throw new Error('courseware view did not render the generate button');
if (!cwText.includes('[back]')) throw new Error('courseware view has no way back');
if (!cwText.includes('[selectAll]')) throw new Error('courseware view has no select-all');

console.log('sidebar ids    :', sidebars.map((item) => item.definition.id).join(', '));
console.log('main keys      :', mains.map((item) => item.definition.key).join(', '));
console.log('list text      :', list.text.slice(0, 120));
console.log('notes text     :', notesText.slice(0, 140));
console.log('courseware text:', cwText.slice(0, 140));
console.log('SMOKE TEST PASSED');
