/**
 * Host half of the Tongji course workbench: serves the course overview
 * JSON consumed by the web panel.
 *
 * Route: GET /dsh-course-workbench/overview
 * Response: { ok, root, generatedAt, courses: [...] }
 *
 * `courseRoot` comes from the plugin row config (cordis.patch.yml); the
 * workspace mapping is read from DSH's own workspace registry so the panel
 * can offer one-click jumps into course projects.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

// Fallback when the plugin row has no `courseRoot`: one folder per course lives
// here. Users are expected to point `courseRoot` at their own folder.
const DEFAULT_COURSE_ROOT = join(homedir(), 'Documents', 'courses');
const ROUTE = '/dsh-course-workbench/overview';
const DIAG_ROUTE = '/dsh-course-workbench/diagnostics';
const SELFTEST_ROUTE = '/dsh-course-workbench/selftest';
const PREVIEW_ROUTE = '/dsh-course-workbench/preview';
const GENERATE_ROUTE = '/dsh-course-workbench/generate';
const ROOTS_ROUTE = '/dsh-course-workbench/roots';
const COURSES_ROUTE = '/dsh-course-workbench/courses';
const NOTE_CHAT_ROUTE = '/dsh-course-workbench/note-chat';
/** How long a queued preview stays eligible once its command has run. */
const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;
const LOGIN_ROUTE = '/dsh-course-workbench/login';
const PACKAGE_ID = 'tongji-course-workbench';
/** Files that count as course materials (课件/讲义). */
const COURSE_FILE_RE = /\.(pptx?|pdf|docx?|xlsx?|zip|rar|md|txt)$/i;
/** Markdown → PDF converter shipped beside the DSH tools (CJK fonts included). */
const MD2PDF_PATH = join(homedir(), '.dsh', 'tools', 'md2pdf.py');

export const inject = ['webServer'];

/**
 * Resolve the Session workspace root for an agent.
 *
 * `workingDirectory.ensure` is the authoritative answer (it is what `present`
 * uses), but it is an optional service: fall back to the Session header so a
 * bare host still names a target instead of silently skipping the preview.
 */
async function agentCwd(ctx, agent, signal) {
  try {
    const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
    if (workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
      const cwd = await workingDirectory.ensure(agent, signal);
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
  } catch {
    // Fall through to the header value.
  }
  const fromHeader = agent?.session?.header?.cwd;
  return typeof fromHeader === 'string' && fromHeader.length > 0 ? fromHeader : undefined;
}

async function resolveSessionCwd(ctx, invocation) {
  return agentCwd(ctx, invocation.agent, invocation.signal);
}

/** Compare workspace paths regardless of separator or trailing slash. */
function normalizePathKey(path) {
  return String(path).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

/** Index live agents by their Session workspace root. */
async function indexLiveSessions(ctx) {
  const byPath = new Map();
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
  if (agents === undefined || typeof agents.list !== 'function') return byPath;
  for (const agent of agents.list()) {
    try {
      const cwd = await agentCwd(ctx, agent, undefined);
      const key = cwd === undefined ? undefined : normalizePathKey(cwd);
      if (key !== undefined && !byPath.has(key)) byPath.set(key, agent);
    } catch {
      // A cold or failing agent simply does not offer a target.
    }
  }
  return byPath;
}

/**
 * The live agent for a course, preferring its note Q&A conversation.
 *
 * Once a course has a dedicated "笔记问答" Session, everything that produces or
 * reads notes should land there rather than in whichever conversation happens
 * to be open — `indexLiveSessions` keeps only the first agent per workspace, so
 * the preference has to be applied on top of it.
 */
async function agentForCourse(ctx, coursePath) {
  const fallback = (await indexLiveSessions(ctx)).get(normalizePathKey(coursePath));
  const chat = (await readNoteChats())[normalizePathKey(coursePath)];
  if (chat === undefined || typeof chat.sessionId !== 'string') return fallback;
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
  if (agents === undefined || typeof agents.list !== 'function') return fallback;
  const preferred = agents.list().find((entry) => entry?.session?.id === chat.sessionId);
  return preferred ?? fallback;
}

/** Whether `target` is `root` or lives beneath it. */
function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string' || target.length === 0) return false;
  const outer = normalizePathKey(root);
  const inner = normalizePathKey(target);
  return inner === outer || inner.startsWith(`${outer}\\`);
}

/**
 * The single folder every generated deliverable lands in, inside the course.
 *
 * Notes, outlines and exam reviews all live together — the user asked for one
 * place named after the course rather than a folder per kind.
 */
function deliverableDir(coursePath) {
  return join(coursePath, `${basename(coursePath)}笔记和复习`);
}

/** The exam-review brief: a summary, then a full problem set with answers. */
function reviewInstructions() {
  return [
    '这是一次**期末复习**任务，产出必须包含两部分，且第二部分放在文末。',
    '',
    '### 第一部分：期末总结',
    '- 按知识板块（不是按讲次）重组全部内容，先给一张"全局框架"表；',
    '- 每个板块写：核心概念、公式/图表含义、典型判据、易混点对比表、考点频率标注（★～★★★）；',
    '- 跨课件的关系要显式写出来（哪几讲在讲同一件事、前后怎么递进）；',
    '- 原文里的图/表/数据要注明来自哪份文件第几页。',
    '',
    '### 第二部分：习题与解答（必须有，放在最后）',
    '题源必须**穷尽**，按下面四类分别整理，不要只挑一部分：',
    '1. **课件里原有的题目**：逐页扫一遍勾选的文件，PPT/PDF 里的思考题、例题、课堂练习、',
    '   随堂测验、案例讨论题，全部收进来，并注明出处（文件名 + 页码/讲次）；',
    '2. **往年试卷/习题集**：如果勾选的文件里有试卷、真题、习题答案，把它们**逐题**整理进来，',
    '   并标注"真题"与年份；同一考点多次出现的，在题目后注明重复次数；',
    '3. **模型预测题**：根据考点频率、易混点和老师强调的重点，自行出题补全，标注"预测"；',
    '4. **综合题**：至少 3 道跨板块的大题，模拟期末压轴。',
    '',
    '每道题都必须给出**完整解答**，不要只给答案要点：',
    '- 计算题：写清公式、代入过程、单位、结果；',
    '- 简答题：分点作答，每点一两句话；',
    '- 论述/综合题：给答题框架（采分点），再用一段话示范；',
    '- 选择题：给出正确选项 + 每个错误选项为什么错。',
    '',
    '题目按题型分组：名词解释 → 选择/判断 → 填空 → 简答 → 计算 → 论述/综合。',
    '每组开头写一句该题型的分值占比与答题策略。',
    '',
    '最后附一张**考点速查表**：考点 | 所属板块 | 出现次数 | 掌握程度建议。',
  ].join('\n');
}

/**
 * Whether a path is a course the panel knows about: under the configured root,
 * under an added root, or one of the individually added course folders.
 *
 * `root` is passed in because the configured course root lives in the plugin's
 * apply() scope, not at module scope.
 */
async function isKnownCoursePath(root, coursePath) {
  if (typeof coursePath !== 'string' || coursePath.length === 0) return false;
  const roots = [root, ...(await readExtraRoots())];
  if (roots.some((entry) => isInside(entry, coursePath))) return true;
  const key = normalizePathKey(coursePath);
  return (await readExtraCourses()).some((entry) => normalizePathKey(entry) === key);
}

/** Prompt for a hand-picked set of courseware files. */
function buildSelectionPrompt({ files, target, pdfTarget, mode }) {
  const list = files.map((file, index) => `${index + 1}. ${file}`).join('\n');
  const skill = mode === 'review' ? 'course-review' : mode === 'outline' ? 'course-outline' : 'course-notes';
  const lines = [
    `用 ${skill} 技能，只处理用户在界面上勾选的这 ${files.length} 份课件：`,
    '',
    list,
    '',
    '注意：**只读这些文件**，不要扫描课程目录里的其他课件；它们可能来自不同讲次或不同子文件夹。',
    '',
    '步骤：',
    '1. 逐份提取全文（.pptx 用 office-pptx，.pdf 用可用的 PDF 读取方式，.docx/.xlsx 用对应的 office 技能）；',
    '2. 按技能规定的结构整理，只覆盖这些课件对应的内容；',
  ];
  if (mode === 'review') {
    lines.push('3. 严格按下面的期末复习要求组织内容：', '', reviewInstructions(), '');
  }
  lines.push(
    `4. 先把 Markdown 写入这个确切路径：${target}`,
    `5. 再把这个 Markdown 转成 PDF：\`python "${MD2PDF_PATH}" "${target}" "${pdfTarget}"\``,
    '   （转换脚本自带中文字体，不需要 Word / LibreOffice；成功后不要删除 md，预览要用它）',
    '6. 回复里**不要贴全文**，只给：两个文件路径、覆盖份数 M/N、章节标题清单，',
    '   期末复习再额外给一句"共整理 X 道题（课件原有 A / 往年真题 B / 预测 C）"。',
  );
  return lines.join('\n');
}

/** Read a JSON request body with a hard size cap. */
async function readJsonBody(request, limit = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readdirSafe(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/**
 * Read DSH's durable workspace registry and index it by directory path,
 * so a course folder can resolve to the workspace the panel should open.
 */
async function readWorkspaceIndex() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const byPath = new Map();
  try {
    const raw = await readFile(join(home, 'storages', 'workspace.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const table = parsed?.tables?.workspaces;
    if (table && typeof table === 'object') {
      for (const [id, row] of Object.entries(table)) {
        if (row && typeof row.path === 'string') {
          byPath.set(row.path, id);
        }
      }
    }
  } catch {
    // Absent or unreadable registry: courses simply render without a jump.
  }
  return byPath;
}

/** Bound for the recursive scan: course trees are shallow, but stay safe. */
const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_ENTRIES = 800;
/** Cap on files the picker receives per course (the overview stays small). */
const MAX_PICKER_FILES = 300;

/** Recursively collect files under one directory, bounded in depth and count. */
async function collectFiles(dir, depth, budget, out) {
  if (depth > MAX_SCAN_DEPTH || budget.left <= 0) return;
  const entries = await readdirSafe(dir);
  for (const entry of entries) {
    if (budget.left <= 0) return;
    budget.left -= 1;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, depth + 1, budget, out);
    } else if (entry.isFile()) {
      const info = await statSafe(full);
      out.push({
        name: entry.name,
        path: full,
        mtimeMs: info ? info.mtimeMs : 0,
        sizeKB: info ? Math.max(0, Math.round(info.size / 102.4) / 10) : 0,
      });
    }
  }
}

/** Persisted extra course roots live next to the other DSH state. */
const ROOTS_STATE_FILE = 'tongji-course-workbench.json';

/** The whole state file, with every section defaulted. */
async function readStateFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(home, ROOTS_STATE_FILE), 'utf8'));
  } catch {
    parsed = undefined;
  }
  const strings = (value) =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
  const chats = parsed?.noteChats;
  return {
    extraRoots: strings(parsed?.extraRoots),
    extraCourses: strings(parsed?.extraCourses),
    noteChats: chats !== null && typeof chats === 'object' && !Array.isArray(chats) ? chats : {},
  };
}

async function readExtraRoots() {
  return (await readStateFile()).extraRoots;
}

/** Individually added course folders (picked one by one, outside any root). */
async function readExtraCourses() {
  return (await readStateFile()).extraCourses;
}

/** Per-course note Q&A sessions: course key → `{sessionId, notePath}`. */
async function readNoteChats() {
  return (await readStateFile()).noteChats;
}

/**
 * Rewrite the state file, keeping every section the caller did not mention.
 *
 * The sections are written by different routes, so an omitted one must survive
 * rather than be reset to empty.
 */
async function writeState({ extraRoots, extraCourses, noteChats }) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const current = await readStateFile();
  const next = {
    extraRoots: extraRoots ?? current.extraRoots,
    extraCourses: extraCourses ?? current.extraCourses,
    noteChats: noteChats ?? current.noteChats,
  };
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ROOTS_STATE_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** Folders the skills write deliverables into; anything here counts as a note. */
const NOTE_DIRS = new Set(['笔记', '提纲', '复习', '讲义笔记']);

/** Whether a course-relative path starts with a deliverable folder. */
function isDeliverablePath(relativePath) {
  const first = relativePath.split(sep)[0];
  // `<课程名>笔记和复习` is the current home; the plain folders are where
  // earlier runs wrote, and stay listed so old files remain visible.
  return first.endsWith('笔记和复习') || NOTE_DIRS.has(first);
}
/** Cap on notes returned per course (the overview stays a few hundred KB). */
const MAX_NOTES = 200;

/** One course folder → counts, latest files, subfolders. */
async function readCourse(coursePath) {
  const entries = await readdirSafe(coursePath);
  const budget = { left: MAX_SCAN_ENTRIES };
  const all = [];
  await collectFiles(coursePath, 0, budget, all);

  // Per top-level subfolder: how many files live inside it (recursively).
  const subfolders = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const inner = [];
    await collectFiles(join(coursePath, entry.name), 1, { left: MAX_SCAN_ENTRIES }, inner);
    subfolders.push({ name: entry.name, files: inner.length });
  }

  const materials = all.filter(
    // Office lock files (`~$...`) are noise in a picker and cannot be read.
    (file) => COURSE_FILE_RE.test(file.name) && !file.name.startsWith('~$'),
  );
  materials.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const lastMs = materials.length > 0 ? materials[0].mtimeMs : 0;

  // The picker lists every courseware file, in lecture order rather than
  // recency, so a selection reads like the course itself.
  const byLecture = [...materials].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }),
  );
  const files = byLecture.slice(0, MAX_PICKER_FILES).map((file) => ({
    name: file.name,
    path: file.path,
    dir: relative(coursePath, file.path).split(sep).slice(0, -1).join('/'),
    ext: extname(file.name).toLowerCase().replace('.', ''),
    mtime: file.mtimeMs > 0 ? new Date(file.mtimeMs).toISOString() : '',
    sizeKB: file.sizeKB,
  }));

  // Anything the skills wrote into 笔记/提纲/复习/讲义笔记 is a deliverable the
  // notes view lists, newest first, tagged with the folder it came from.
  const notes = all
    .map((file) => ({ file, rel: relative(coursePath, file.path) }))
    .filter(({ rel }) => isDeliverablePath(rel))
    .sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
    .slice(0, MAX_NOTES)
    .map(({ file, rel }) => ({
      name: file.name,
      path: file.path,
      dir: rel.split(sep)[0],
      mtime: file.mtimeMs > 0 ? new Date(file.mtimeMs).toISOString() : '',
      sizeKB: file.sizeKB,
    }));

  return {
    courseFileCount: materials.length,
    files,
    notes,
    truncated: materials.length > files.length,
    subfolders: subfolders.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    latestFiles: materials.slice(0, 5).map((file) => ({
      name: file.name,
      mtime: file.mtimeMs > 0 ? new Date(file.mtimeMs).toISOString() : '',
      sizeKB: file.sizeKB,
    })),
    lastModified: lastMs > 0 ? new Date(lastMs).toISOString() : '',
  };
}

export function apply(ctx, config = {}) {
  const courseRoot =
    typeof config.courseRoot === 'string' && config.courseRoot.trim().length > 0
      ? config.courseRoot
      : DEFAULT_COURSE_ROOT;

  // Optional: the client-modules service answers whether this package's
  // browser half is composed into the page graph. Used by the diagnostics
  // route so composition can be verified without a browser session.
  let clientModules;
  try {
    ctx.inject(['clientModules'], (scoped) => {
      clientModules = scoped.clientModules;
    });
  } catch {
    // Older hosts: diagnostics report "unavailable".
  }

  // Optional: the connection + webApp services can hand out a URL carrying
  // this process's launch token, which is what a browser needs to mint its
  // session cookie. Without them the login route reports "unavailable".
  let connection;
  let webApp;
  try {
    ctx.inject(['connection', 'webApp'], (scoped) => {
      connection = scoped.connection;
      webApp = scoped.webApp;
    });
  } catch {
    // Older hosts: login route reports "unavailable".
  }

  // Slash commands this generation actually registered; the diagnostics route
  // reports it so a reload can be verified without opening the composer.
  const registeredCommands = [];

  /**
   * Output paths whose completion should pop the right-hand preview, keyed by
   * session id. The command records the exact path it told the model to write;
   * the preview route hands it to the Client only once the file exists.
   */
  const pendingPreviews = new Map();

  /**
   * Register one slash command that enqueues a prompt for the receiving agent.
   *
   * A command handler runs outside the model loop, so the only way to make a
   * one-keystroke workflow do real work is to hand the prompt to the agent's
   * own inbox: `followup` appends it to the next turn and wakes the driver,
   * which is exactly what typing the same text into the composer would do.
   * The message is built by hand (role/id/content/source) because the
   * `@deepseek-ai/dsh-llm` helpers are not resolvable from a linked plugin.
   */
  const registerCourseCommand = (scoped, definition) => {
    const { name, description, hint, stem, buildPrompt } = definition;
    const dispose = scoped.commands.register({
      name,
      description,
      input: { hint },
      handler: async (invocation) => {
        const extra = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
        const sessionId = invocation.agent?.session?.id;
        const cwd = await resolveSessionCwd(ctx, invocation);
        // Every deliverable is a Markdown file plus a PDF of the same name, in
        // the course's own 笔记和复习 folder. The md is what the preview shows.
        const courseName = cwd === undefined ? undefined : basename(cwd);
        const dir = cwd === undefined ? undefined : deliverableDir(cwd);
        const mdTarget = dir === undefined ? undefined : join(dir, `${courseName}${stem}.md`);
        const pdfTarget = dir === undefined ? undefined : join(dir, `${courseName}${stem}.pdf`);
        const prompt = buildPrompt({ extra, mdTarget, pdfTarget });
        try {
          invocation.agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          });
        } catch (error) {
          // Degrade to the manual path rather than losing the prompt.
          return {
            kind: 'error',
            text: [
              `/${name} 无法自动发起本轮：${String((error && error.message) || error)}`,
              '把下面这段直接粘贴到输入框即可：',
              '',
              prompt,
            ].join('\n'),
          };
        }
        if (mdTarget !== undefined && sessionId !== undefined) {
          pendingPreviews.set(sessionId, { path: mdTarget, cwd, at: Date.now() });
        }
        return {
          kind: 'success',
          text: [
            `已发起 /${name}，模型开始读取当前课程的课件…`,
            ...(mdTarget === undefined
              ? []
              : [`完成后自动在右侧打开：${mdTarget}`, `同时生成 PDF：${pdfTarget}`]),
          ].join('\n'),
        };
      },
    });
    registeredCommands.push(name);
    return dispose;
  };

  try {
    ctx.inject(['commands'], (scoped) => {
      ctx.effect(() =>
        registerCourseCommand(scoped, {
          name: 'outline',
          description: '读取当前课程全部课件，生成课程提纲（含课件内相关资料）',
          hint: '（可选）限定范围，例如：只做前 8 讲',
          stem: '-课程提纲',
          buildPrompt: ({ extra, mdTarget, pdfTarget }) =>
            [
              '用 course-outline 技能为当前课程生成一份课程提纲。',
              '',
              '当前课程目录 = 本会话工作区根目录。步骤：',
              '1. 递归列出该目录下全部 .pptx/.pdf，按讲次排序，记下总数 N；',
              '2. 用 office-pptx 逐讲提取文字（提取不到的讲次记下来，不要编造内容）；',
              '3. **到课件里翻资料**：每讲都找一遍参考文献/书目、老师标注的「参考资料」「延伸阅读」、',
              '   图表与数据出处、案例来源、课件里的外部链接，整理进提纲的「相关资料」与「资料索引」；',
              '   确实没有就写「未发现」，不要用常识补。',
              '4. 按技能规定结构，先把 Markdown 写入这个确切路径：',
              `   ${mdTarget ?? '「<课程>/<课程名>笔记和复习/<课程名>-课程提纲.md」'}`,
              '5. 再把这个 Markdown 转成 PDF（保留 md，预览要用它）：',
              `   python "${MD2PDF_PATH}" "${mdTarget ?? '<md>'}" "${pdfTarget ?? '<pdf>'}"`,
              '6. 回复里**不要贴全文**，只给：两个文件路径、覆盖讲次 M/N、跳过的讲次及原因、资料索引条数。',
              ...(extra === '' ? [] : ['', `用户补充要求：${extra}`]),
            ].join('\n'),
        }),
      );

      ctx.effect(() =>
        registerCourseCommand(scoped, {
          name: 'notes',
          description: '读取当前课程全部课件，提炼知识点写一份完整笔记',
          hint: '（可选）限定范围，例如：只做沉积相部分',
          stem: '-知识点笔记',
          buildPrompt: ({ extra, mdTarget, pdfTarget }) =>
            [
              '用 course-notes 技能，读取当前课程的全部课件，提炼知识点并写一份完整笔记。',
              '',
              '当前课程目录 = 本会话工作区根目录。步骤：',
              '1. 递归列出全部 .pptx/.pdf，按讲次排序，记下总数 N；',
              '2. 用 office-pptx 逐讲提取全文（含表格与备注）；',
              '3. 按技能规定结构，先把 Markdown 写入这个确切路径：',
              `   ${mdTarget ?? '「<课程>/<课程名>笔记和复习/<课程名>-知识点笔记.md」'}`,
              '4. 再把这个 Markdown 转成 PDF（保留 md，预览要用它）：',
              `   python "${MD2PDF_PATH}" "${mdTarget ?? '<md>'}" "${pdfTarget ?? '<pdf>'}"`,
              '5. 回复里**不要贴全文**，只给：两个文件路径、总字数、覆盖讲次 M/N、需人工补看的讲次。',
              ...(extra === '' ? [] : ['', `用户补充要求：${extra}`]),
            ].join('\n'),
        }),
      );

      ctx.effect(() =>
        registerCourseCommand(scoped, {
          name: 'review',
          description: '期末复习：全课程总结 + 习题与解答（含课件原题、往年真题、预测题）',
          hint: '（可选）限定范围，例如：只复习后六讲 / 重点沉积相',
          stem: '-期末复习',
          buildPrompt: ({ extra, mdTarget, pdfTarget }) =>
            [
              '用 course-review 技能为当前课程做期末复习。',
              '',
              '当前课程目录 = 本会话工作区根目录。步骤：',
              '1. 递归列出全部 .pptx/.pdf/.docx，按讲次排序，记下总数 N；',
              '2. 逐份提取全文，**特别注意每一页上的题目、例题、思考题、随堂练习**，',
              '   以及试卷/真题/习题答案类文件；',
              '3. 按技能规定结构整理，并严格执行下面的期末复习要求：',
              '',
              reviewInstructions(),
              '',
              '4. 先把 Markdown 写入这个确切路径：',
              `   ${mdTarget ?? '「<课程>/<课程名>笔记和复习/<课程名>-期末复习.md」'}`,
              '5. 再把这个 Markdown 转成 PDF（保留 md，预览要用它）：',
              `   python "${MD2PDF_PATH}" "${mdTarget ?? '<md>'}" "${pdfTarget ?? '<pdf>'}"`,
              '6. 回复里**不要贴全文**，只给：两个文件路径、覆盖讲次 M/N、',
              '   「共整理 X 道题（课件原有 A / 往年真题 B / 预测 C）」。',
              ...(extra === '' ? [] : ['', `用户补充要求：${extra}`]),
            ].join('\n'),
        }),
      );
    });
  } catch {
    // No commands service: the panel still works, only the shortcuts are absent.
  }

  /**
   * Claim one exact route. A path another generation already owns (a
   * hot-reloaded fiber, for instance) is taken over by the current handler
   * instead of failing the whole activation; the disposer removes the entry
   * only while it still points at this generation's route.
   */
  const claimRoute = (route) => {
    const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes;
    if (table !== undefined && typeof table.has === 'function' && table.has(route.path)) {
      table.set(route.path, route);
      return () => {
        if (table.get(route.path) === route) table.delete(route.path);
      };
    }
    return ctx.webServer.register(route);
  };

  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: LOGIN_ROUTE,
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(response, 405, { ok: false, error: 'GET only' });
          return;
        }
        let target;
        try {
          if (connection === undefined || webApp === undefined) throw new Error('connection service unavailable');
          target = connection.authenticatedUrl(webApp.getAdvertisedUrl());
        } catch (error) {
          sendJson(response, 503, { ok: false, error: String((error && error.message) || error) });
          return;
        }
        response.writeHead(302, {
          location: target,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        response.end();
      },
    }),
  );

  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: DIAG_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(response, 405, { ok: false, error: 'GET only' });
          return;
        }
        try {
          const graph = typeof clientModules?.graph === 'function' ? clientModules.graph() : undefined;
          const entries = Array.isArray(graph?.entries) ? graph.entries : [];
          sendJson(response, 200, {
            ok: true,
            packageId: PACKAGE_ID,
            clientModules: graph === undefined ? 'unavailable' : 'available',
            graphRev: graph?.rev,
            entryIds: entries.map((entry) => entry.id),
            ours: entries.find((entry) => entry.id === PACKAGE_ID) ?? null,
            commands: registeredCommands,
            pendingPreviews: pendingPreviews.size,
          });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: GENERATE_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'POST only' });
          return;
        }
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
          return;
        }
        const coursePath = typeof body.coursePath === 'string' ? body.coursePath : '';
        const wanted = Array.isArray(body.files) ? body.files.filter((p) => typeof p === 'string') : [];
        // Both halves are always produced: the Markdown is the preview, the PDF
        // is what the user actually prints or reads on a tablet.
        const mode = body.mode === 'review' ? 'review' : body.mode === 'outline' ? 'outline' : 'notes';

        if (wanted.length === 0) {
          sendJson(response, 400, { ok: false, error: 'no-files', message: '没有勾选任何课件' });
          return;
        }
        // Stay inside a known course: the configured root, any added root, or
        // one of the individually added course folders. Anything else is a
        // malformed request.
        if (!(await isKnownCoursePath(courseRoot, coursePath))) {
          sendJson(response, 400, { ok: false, error: 'bad-course', message: '课程目录不在配置的根目录下' });
          return;
        }
        const files = [];
        for (const file of wanted) {
          if (!isInside(coursePath, file)) {
            sendJson(response, 400, { ok: false, error: 'bad-file', message: `文件不在课程目录内：${file}` });
            return;
          }
          const info = await statSafe(file);
          if (info === undefined || !info.isFile()) {
            sendJson(response, 400, { ok: false, error: 'missing-file', message: `文件不存在：${file}` });
            return;
          }
          files.push(file);
        }

        const agent = await agentForCourse(ctx, coursePath);
        if (agent === undefined) {
          sendJson(response, 409, {
            ok: false,
            error: 'no-session',
            message: '这门课还没有打开的会话：先在左侧「课程」面板点「进入项目」，再回来勾选。',
          });
          return;
        }

        const courseName = basename(coursePath);
        // Local wall-clock stamp: the file name is read by the user, not by a
        // machine, so UTC would just be confusing.
        const now = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        const label = mode === 'review' ? '期末复习' : mode === 'outline' ? '选摘提纲' : '选摘笔记';
        const stem = `${courseName}-${label}-${stamp}`;
        const dir = deliverableDir(coursePath);
        const target = join(dir, `${stem}.md`);
        const pdfTarget = join(dir, `${stem}.pdf`);
        const prompt = buildSelectionPrompt({ files, target, pdfTarget, mode });
        try {
          agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          });
        } catch (error) {
          sendJson(response, 500, {
            ok: false,
            error: 'followup-failed',
            message: String((error && error.message) || error),
          });
          return;
        }
        pendingPreviews.set(agent.session.id, { path: target, cwd: coursePath, at: Date.now() });
        sendJson(response, 200, {
          ok: true,
          sessionId: agent.session.id,
          target,
          pdfTarget,
          mode,
          count: files.length,
        });
      },
    }),
  );

  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: PREVIEW_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: 'GET only' });
          return;
        }
        const url = new URL(request.url, 'http://127.0.0.1');

        // The Client confirms a tab it actually opened; only then is the entry
        // dropped. An entry the Client could not open (no Session surface is
        // mounted, for instance) stays queued and is retried on the next poll.
        if (url.searchParams.get('ack') === '1') {
          const sessionId = url.searchParams.get('sessionId');
          const removed = sessionId === null ? false : pendingPreviews.delete(sessionId);
          sendJson(response, 200, { ok: true, acked: removed });
          return;
        }

        const now = Date.now();
        for (const [sessionId, entry] of pendingPreviews) {
          if (now - entry.at > PREVIEW_TTL_MS) {
            pendingPreviews.delete(sessionId);
            continue;
          }
          let ready = false;
          try {
            ready = (await stat(entry.path)).isFile();
          } catch {
            ready = false;
          }
          if (!ready) continue;
          // Prefer the workspace-relative spelling the shipped previews use;
          // fall back to the absolute path when the file sits outside the root.
          const rel = entry.cwd === undefined ? '' : relative(entry.cwd, entry.path);
          const addressPath =
            rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
              ? rel.split(sep).join('/')
              : entry.path;
          sendJson(response, 200, { ok: true, sessionId, path: addressPath });
          return;
        }
        sendJson(response, 200, { ok: false });
      },
    }),
  );

  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: SELFTEST_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: 'GET only' });
          return;
        }
        const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
        if (agents === undefined || typeof agents.list !== 'function') {
          sendJson(response, 503, { ok: false, error: 'agents service unavailable' });
          return;
        }
        const live = agents.list();
        const agent = live[0];
        if (agent === undefined) {
          sendJson(response, 409, { ok: false, error: 'no live agent to probe' });
          return;
        }
        // Probe the exact message shape the slash commands enqueue, without
        // waking the driver: `inject` takes the same inbox path as `followup`
        // but never starts a turn, and the probe is withdrawn immediately.
        const id = randomUUID();
        const probe = {
          id,
          role: 'user',
          content: [{ type: 'text', text: '[course-workbench selftest] message shape probe' }],
          source: { kind: 'user' },
        };
        try {
          agent.inject(probe);
          const pending = agent.inbox.nextStep.length + agent.inbox.nextTurn.length;
          const removed = agent.inbox.remove(id);
          // `?preview=<absolute path>` additionally queues one preview for this
          // Session, which exercises the whole host→client handoff without
          // running a real course workflow.
          const requested = new URL(request.url, 'http://127.0.0.1').searchParams.get('preview');
          let queued;
          if (requested !== null) {
            try {
              queued = (await stat(requested)).isFile() ? requested : undefined;
            } catch {
              queued = undefined;
            }
            if (queued !== undefined) {
              pendingPreviews.set(agent.session.id, { path: queued, cwd: undefined, at: Date.now() });
            }
          }
          sendJson(response, 200, {
            ok: true,
            accepted: true,
            removed,
            pendingDuringProbe: pending,
            agentId: agent.id,
            ...(requested === null ? {} : { previewQueued: queued ?? null }),
          });
        } catch (error) {
          sendJson(response, 500, {
            ok: false,
            accepted: false,
            error: String((error && error.message) || error),
          });
        }
      },
    }),
  );

  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: ROOTS_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'POST only' });
          return;
        }
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
          return;
        }
        const action = body.action === 'remove' ? 'remove' : 'add';
        const path = typeof body.path === 'string' ? body.path.trim() : '';
        const extras = await readExtraRoots();
        const courses = await readExtraCourses();
        if (action === 'add') {
          const info = await statSafe(path);
          if (info === undefined || !info.isDirectory()) {
            sendJson(response, 400, { ok: false, error: 'not-a-directory', message: `目录不存在：${path}` });
            return;
          }
          if (normalizePathKey(path) !== normalizePathKey(courseRoot)) {
            if (!extras.some((entry) => normalizePathKey(entry) === normalizePathKey(path))) {
              extras.push(path);
              await writeState({ extraRoots: extras, extraCourses: courses });
            }
          }
        } else {
          const kept = extras.filter((entry) => normalizePathKey(entry) !== normalizePathKey(path));
          if (kept.length !== extras.length) {
            await writeState({ extraRoots: kept, extraCourses: courses });
          }
        }
        const roots = [
          { path: courseRoot, removable: false },
          ...(await readExtraRoots()).map((entry) => ({ path: entry, removable: true })),
        ];
        sendJson(response, 200, { ok: true, roots });
      },
    }),
  );

  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: COURSES_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'POST only' });
          return;
        }
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
          return;
        }
        const action = body.action === 'remove' ? 'remove' : 'add';
        const path = typeof body.path === 'string' ? body.path.trim().replace(/[\\/]+$/, '') : '';
        const extraRoots = await readExtraRoots();
        const extras = await readExtraCourses();
        if (action === 'add') {
          const info = await statSafe(path);
          if (info === undefined || !info.isDirectory()) {
            sendJson(response, 400, { ok: false, error: 'not-a-directory', message: `目录不存在：${path}` });
            return;
          }
          if (!extras.some((entry) => normalizePathKey(entry) === normalizePathKey(path))) {
            extras.push(path);
            await writeState({ extraRoots, extraCourses: extras });
          }
        } else {
          const kept = extras.filter((entry) => normalizePathKey(entry) !== normalizePathKey(path));
          if (kept.length !== extras.length) {
            await writeState({ extraRoots, extraCourses: kept });
          }
        }
        sendJson(response, 200, { ok: true, courses: await readExtraCourses() });
      },
    }),
  );

  // Per-course note Q&A conversations. The Client creates the Session (only it
  // can) and reports it here; this route just remembers which one belongs to
  // which course so a second click reopens instead of piling up Sessions.
  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: NOTE_CHAT_ROUTE,
      handler: async (request, response) => {
        const chats = await readNoteChats();
        if (request.method === 'GET') {
          const coursePath = new URL(request.url, 'http://127.0.0.1').searchParams.get('course');
          if (coursePath === null || coursePath.length === 0) {
            sendJson(response, 400, { ok: false, error: 'course required' });
            return;
          }
          const chat = chats[normalizePathKey(coursePath)];
          sendJson(response, 200, {
            ok: true,
            sessionId: typeof chat?.sessionId === 'string' ? chat.sessionId : null,
            notePath: typeof chat?.notePath === 'string' ? chat.notePath : '',
          });
          return;
        }
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'GET or POST only' });
          return;
        }
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
          return;
        }
        const coursePath = typeof body.coursePath === 'string' ? body.coursePath.trim() : '';
        if (coursePath.length === 0 || (await statSafe(coursePath)) === undefined) {
          sendJson(response, 400, { ok: false, error: 'bad-course' });
          return;
        }
        const key = normalizePathKey(coursePath);
        if (body.action === 'clear') {
          delete chats[key];
          await writeState({ noteChats: chats });
          sendJson(response, 200, { ok: true, cleared: true });
          return;
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (sessionId.length === 0 || sessionId.length > 200) {
          sendJson(response, 400, { ok: false, error: 'bad-session' });
          return;
        }
        const notePath = typeof body.notePath === 'string' ? body.notePath.trim() : '';
        chats[key] = { sessionId, notePath, at: new Date().toISOString() };
        await writeState({ noteChats: chats });
        sendJson(response, 200, { ok: true, sessionId });
      },
    }),
  );

  ctx.effect(() =>
    claimRoute({
      kind: 'exact',
      path: ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(response, 405, { ok: false, error: 'GET only' });
          return;
        }
        try {
          const extraRoots = await readExtraRoots();
          const roots = [
            { path: courseRoot, removable: false },
            ...extraRoots
              .filter((path) => normalizePathKey(path) !== normalizePathKey(courseRoot))
              .map((path) => ({ path, removable: true })),
          ];
          const workspaces = await readWorkspaceIndex();
          const courses = [];
          const seen = new Set();
          const pushCourse = async (path, rootPath, extra) => {
            const key = normalizePathKey(path);
            if (seen.has(key)) return;
            seen.add(key);
            const course = {
              name: basename(path),
              path,
              root: rootPath,
              ...(await readCourse(path)),
            };
            if (extra) course.extra = true;
            const workspaceId = workspaces.get(path);
            if (workspaceId !== undefined) course.workspaceId = workspaceId;
            courses.push(course);
          };
          for (const root of roots) {
            const entries = await readdirSafe(root.path);
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              await pushCourse(join(root.path, entry.name), root.path, false);
            }
          }
          // Individually added course folders may live outside every root.
          for (const path of await readExtraCourses()) {
            if ((await statSafe(path)) === undefined) continue;
            await pushCourse(path, dirname(path), true);
          }
          courses.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
          // A course can only receive generated notes when a conversation for
          // it is open, so tell the picker which ones are ready.
          const liveSessions = await indexLiveSessions(ctx);
          const noteChats = await readNoteChats();
          const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
          const liveAgents = agents !== undefined && typeof agents.list === 'function' ? agents.list() : [];
          for (const course of courses) {
            const key = normalizePathKey(course.path);
            const chat = noteChats[key];
            const preferred =
              chat !== undefined && typeof chat.sessionId === 'string'
                ? liveAgents.find((entry) => entry?.session?.id === chat.sessionId)
                : undefined;
            const agent = preferred ?? liveSessions.get(key);
            if (agent !== undefined) course.sessionId = agent.session.id;
            // Which note each course's Q&A conversation is currently on, so the
            // notes view can mark it and skip a redundant switch message.
            if (chat !== undefined && typeof chat.sessionId === 'string') {
              course.noteChat = { sessionId: chat.sessionId, notePath: chat.notePath ?? '' };
            }
          }
          sendJson(response, 200, {
            ok: true,
            root: courseRoot,
            roots,
            generatedAt: new Date().toISOString(),
            courses,
          });
        } catch (error) {
          sendJson(response, 500, {
            ok: false,
            error: String((error && error.message) || error),
          });
        }
      },
    }),
  );
}
