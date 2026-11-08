/**
 * Client half of the Tongji course workbench: a "课程" sidebar panel that
 * shows every course of the current semester with latest files, and jumps
 * into a course project's workspace in one click.
 */
window.__ModuleLoader__.load({
  id: 'tongji-course-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'tongji-course-workbench';
    const PANEL_ID = 'course-workbench';
    const OVERVIEW_URL = '/dsh-course-workbench/overview';
    const PREVIEW_URL = '/dsh-course-workbench/preview';
    const GENERATE_URL = '/dsh-course-workbench/generate';
    const NOTE_CHAT_URL = '/dsh-course-workbench/note-chat';
    const ROOTS_URL = '/dsh-course-workbench/roots';
    const COURSES_URL = '/dsh-course-workbench/courses';
    /** How often the sidebar watches for a finished note/outline to preview. */
    const PREVIEW_POLL_MS = 2500;

    // The Client half has no Session binding in the panels it registers, so the
    // Host names the Session in the preview payload and the plugin context is
    // captured here for the polling hook.
    let clientContext;
    /** Right-Sidebar face, resolved through `ctx.inject` when the host ships it. */
    let sidebarRightService;
    let sessionsService;
    /** Workspace registry face: creates a project for a course folder on demand. */
    let workspacesService;
    /** Layout face: selects which global panel the main area shows. */
    let layoutService;

    /**
     * Bring a global panel to the main area (`null` returns to the conversation).
     * Failures are swallowed: a shell without the layout service still renders
     * the panel, it just cannot be selected programmatically.
     */
    function showPanel(panelId) {
      try {
        if (layoutService !== undefined) layoutService.selectPanel(panelId);
      } catch {
        // Unregistered panel id, or a shell without the service.
      }
    }

    /**
     * Open one workspace file in the right sidebar.
     *
     * The service refuses to act unless a Session surface is mounted — that is,
     * unless its conversation is the thing on screen — so the outcome is
     * reported rather than swallowed, and callers can switch the main view and
     * retry instead of showing a dead click.
     */
    function tryPreview(sessionId, path) {
      const service =
        sidebarRightService ??
        (clientContext && typeof clientContext.get === 'function'
          ? clientContext.get('sidebarRight')
          : undefined);
      if (service === undefined) return { ok: false, reason: 'sidebarRight 服务未注入' };
      if (typeof service.openResource !== 'function') {
        return { ok: false, reason: 'sidebarRight 缺少 openResource' };
      }
      try {
        service.openResource(previewAddress(sessionId, path));
        return { ok: true, reason: '' };
      } catch (error) {
        return { ok: false, reason: String((error && error.message) || error) };
      }
    }

    /**
     * Open a preview, first bringing the owning Session on screen.
     *
     * Mounting is asynchronous, so the open is retried for a short window; the
     * first attempt covers the common case where that conversation is already
     * the mounted one.
     */
    function previewAfterMount(uiWorkspace, sessionId, path, onResult) {
      const first = tryPreview(sessionId, path);
      if (first.ok) {
        onResult(first);
        return;
      }
      try {
        if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
          uiWorkspace.openSession(sessionId);
        }
      } catch {
        // Fall through to the retry loop; the message will say why.
      }
      let attempts = 0;
      const tick = () => {
        attempts += 1;
        const result = tryPreview(sessionId, path);
        if (result.ok || attempts >= 12) {
          onResult(result);
          return;
        }
        setTimeout(tick, 120);
      };
      setTimeout(tick, 120);
    }

    /**
     * Ask the desktop for one folder.
     *
     * The native picker plugin installs a global; without it, the workspace
     * service exposes the same chooser. Returns `null` when the user cancels.
     */
    async function pickDirectory(uiWorkspace) {
      const desktop =
        typeof globalThis === 'undefined' ? undefined : globalThis.__DSH_DIRECTORY_PICKER__;
      if (desktop !== undefined && typeof desktop.pick === 'function') return await desktop.pick();
      if (uiWorkspace !== undefined && typeof uiWorkspace.pickDirectory === 'function') {
        return await uiWorkspace.pickDirectory();
      }
      throw new Error('directory picker unavailable');
    }

    /**
     * The workspace record for a course folder, created on first use.
     *
     * A course folder has no project record until something opens it, and a
     * Session cannot exist outside a project, so this is the first step of both
     * "enter the project" and "ask about this note".
     */
    async function ensureWorkspace(course) {
      if (course.workspaceId !== undefined) return course.workspaceId;
      if (workspacesService === undefined) throw new Error('workspaces service unavailable');
      const workspace = await workspacesService.create({ path: course.path });
      const workspaceId = workspace && workspace.workspaceId;
      if (workspaceId === undefined) throw new Error('workspace was not created');
      return workspaceId;
    }

    /**
     * Adopt a course folder as a project and open a Session on it.
     *
     * A new course folder has no workspace record, so nothing can be handed to
     * it yet; creating the record is the same call the shipped "add workspace"
     * menu makes, and `openWorkspace` then creates the blank Session whose cwd
     * is that folder.
     */
    async function adoptCourse(course, uiWorkspace) {
      const workspaceId = await ensureWorkspace(course);
      if (uiWorkspace) await uiWorkspace.openWorkspace(workspaceId);
      return workspaceId;
    }

    /** Encode one path segment, keeping the drive-letter colon literal. */
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':');
    }

    /** Compare two folders the way the Host does: separators and case ignored. */
    function normalizePathKey(value) {
      return String(value || '')
        .replace(/[\\/]+/g, '\\')
        .replace(/\\+$/, '')
        .toLowerCase();
    }

    /** True when `candidate` is `root` itself or lives inside it. */
    function isUnderRoot(root, candidate) {
      const base = normalizePathKey(root);
      if (base.length === 0) return true;
      const path = normalizePathKey(candidate);
      return path === base || path.startsWith(base + '\\');
    }

    /** Last path segment, used as the chip label. */
    function lastSegment(value) {
      const parts = String(value || '')
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/);
      return parts[parts.length - 1] || String(value || '');
    }

    /**
     * Build the `dsh-resource://` address the right sidebar opens.
     * Mirrors the Host-side file address format used by the shipped previews.
     */
    function previewAddress(sessionId, path) {
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      const encoded = normalized.split('/').map(encodeSegment).join('/');
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`;
    }

    // Flat string dictionaries with {0} placeholders, the format the client
    // locale service expects (see dshmarket locales.ts).
    const zh = {
      nav: '课程',
      title: '课程工作台',
      refresh: '刷新',
      loading: '正在读取课程目录…',
      loadFailed: '读取失败',
      openProject: '进入项目',
      createProject: '新建项目',
      openCourseware: '打开课件',
      back: '← 课程',
      noProject: '未创建项目',
      noProjectHint: '（在左侧工作区列表中新建）',
      materials: '课件/资料 {0} 项',
      latestUpdate: '最近更新 {0}',
      subfolders: '子文件夹 {0} 个',
      updatedAt: '更新于 {0}',
      skillsTitle: '斜杠命令（在课程项目的会话里输入）',
      cmdOutlineName: '/outline',
      cmdOutlineHint: '读全部课件 → 课程提纲',
      cmdNotesName: '/notes',
      cmdNotesHint: '读全部课件 → 知识点笔记',
      skillsSubtitle: '也可以直接用自然语言点名技能',
      skillReviewName: '复习备考',
      skillReviewHint: '「用 course-review 帮我把这门课整理成复习提纲和速查表」',
      skillDigestName: '课件消化',
      skillDigestHint: '「用 course-digest 把最新一讲课件做成笔记」',
      skillAssignName: '作业助手',
      skillAssignHint: '「用 course-assignment 帮我完成这次的作业/报告」',
      noCourses: '课程目录为空',
      allRoots: '全部',
      noCoursesInRoot: '这个目录下还没有课程',
      navMaterials: '课件',
      pickerTitle: '课件笔记',
      pickerHint: '勾选课件 → 只读选中的文件生成笔记',
      selectAll: '全选',
      clearAll: '清空',
      generate: '生成笔记（已选 {0}）',
      generating: '正在提交…',
      noSessionShort: '未开会话',
      noSessionHint: '先到「课程」面板点「进入项目」，再回来勾选',
      filesCount: '{0} 个文件',
      noFiles: '这门课还没有课件',
      formatMd: 'Markdown',
      formatDocx: 'Word',
      review: '期末复习',
      reviewHint: '勾选要复习的课件，生成期末总结 + 习题与解答',
      reviewBody:
        '会整理成：① 期末总结（按知识板块重组）② 习题与解答（课件原题 + 往年真题 + 预测题，每题带完整解答）③ 考点速查表。输出 Markdown + PDF。',
      generateReview: '生成期末复习（已选 {0}）',
      outputBoth: '输出：Markdown + PDF',
      noticeOk: '已开始生成：',
      noticeErr: '失败：',
      pickerEmpty: '没有可勾选的课件',
      addRoot: '＋ 添加目录',
      rootPlaceholder: '课程根目录，例如 D:\\课程\\大四A',
      confirm: '确定',
      removeRoot: '移除',
      addCourse: '＋ 新增项目',
      picking: '选择中…',
      removeCourse: '从列表移除',
      tabCourses: '课程',
      tabNotes: '笔记',
      notesTitle: '已生成的笔记',
      notesEmpty: '还没有生成过笔记：先到「课程」里选一门课，用 /notes 或课件面板生成。',
      noteCount: '{0} 篇',
      noNotesYet: '暂无笔记',
      noSessionNote: '这门课还没有打开的会话，先「进入项目」才能预览。',
      previewFailed: '预览打不开（右侧栏服务不可用）。',
      opening: '正在打开预览…',
      askNote: '提问',
      askNoteHint: '为这篇笔记开一个问答会话（每门课一个，复用）',
      asking: '正在准备…',
      askFailed: '问答会话打不开：',
      askPrefilled: '问题已填进输入框，按回车开始。',
      noteChatBadge: '问答',
    };
    const en = {
      nav: 'Courses',
      title: 'Course Workbench',
      refresh: 'Refresh',
      loading: 'Reading course folders…',
      loadFailed: 'Load failed',
      openProject: 'Open project',
      createProject: 'New project',
      openCourseware: 'Open courseware',
      back: '← Courses',
      noProject: 'No project yet',
      noProjectHint: '(create it in the workspace list first)',
      materials: '{0} course files',
      latestUpdate: 'Updated {0}',
      subfolders: '{0} folders',
      updatedAt: 'Updated {0}',
      skillsTitle: 'Slash commands (type in a course project session)',
      cmdOutlineName: '/outline',
      cmdOutlineHint: 'all slides → course outline',
      cmdNotesName: '/notes',
      cmdNotesHint: 'all slides → knowledge notes',
      skillsSubtitle: 'Or just name the skill in plain language',
      skillReviewName: 'Exam review',
      skillReviewHint: '"course-review: outline + cheat sheet for this course"',
      skillDigestName: 'Lecture digest',
      skillDigestHint: '"course-digest: turn the latest slides into notes"',
      skillAssignName: 'Assignments',
      skillAssignHint: '"course-assignment: help me with this homework/report"',
      noCourses: 'No courses found',
      allRoots: 'All',
      noCoursesInRoot: 'No courses in this folder yet',
      navMaterials: 'Materials',
      pickerTitle: 'Courseware notes',
      pickerHint: 'Pick slides, then generate notes from exactly those files',
      selectAll: 'Select all',
      clearAll: 'Clear',
      generate: 'Generate notes ({0} picked)',
      generating: 'Submitting…',
      noSessionShort: 'no session',
      noSessionHint: 'Open the course project first, then come back and pick files',
      filesCount: '{0} files',
      noFiles: 'No courseware in this course yet',
      formatMd: 'Markdown',
      formatDocx: 'Word',
      review: 'Final review',
      reviewHint: 'Pick the courseware to review: summary + problem set with answers',
      reviewBody:
        'Produces: (1) a final summary regrouped by topic, (2) a problem set with full solutions (slides, past papers, predicted questions), (3) a cheat sheet. Saved as Markdown + PDF.',
      generateReview: 'Build review ({0} selected)',
      outputBoth: 'Output: Markdown + PDF',
      noticeOk: 'Started:',
      noticeErr: 'Failed:',
      pickerEmpty: 'Nothing to pick',
      addRoot: '+ Add folder',
      rootPlaceholder: 'Course root, e.g. D:\\courses\\senior-A',
      confirm: 'OK',
      removeRoot: 'Remove',
      addCourse: '+ New course',
      picking: 'Choosing…',
      removeCourse: 'Remove from list',
      tabCourses: 'Courses',
      tabNotes: 'Notes',
      notesTitle: 'Generated notes',
      notesEmpty: 'No notes yet — pick a course and run /notes or the courseware panel.',
      noteCount: '{0} notes',
      noNotesYet: 'No notes',
      noSessionNote: 'This course has no open conversation yet; enter the project to preview.',
      previewFailed: 'Preview failed:',
      opening: 'Opening preview…',
      askNote: 'Ask',
      askNoteHint: 'Open the note Q&A conversation for this course (one per course, reused)',
      asking: 'Preparing…',
      askFailed: 'Could not open the Q&A conversation:',
      askPrefilled: 'The question is in the composer — press Enter to start.',
      noteChatBadge: 'Q&A',
    };

    /** Translate one key, substituting {0} when an argument is given. */
    function tr(t, key, arg) {
      let text = t(key);
      if (typeof text !== 'string') return key;
      if (arg !== undefined) text = text.replace('{0}', String(arg));
      return text;
    }

    const s = {
      page: {
        padding: '20px 24px',
        overflowY: 'auto',
        minHeight: 0,
        flex: '1 1 auto',
        color: 'var(--dsw-alias-label-primary)',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 4,
      },
      title: {
        fontSize: 18,
        fontWeight: 600,
        margin: 0,
        flex: '0 0 auto',
      },
      rootPath: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '1 1 auto',
      },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '4px 12px',
        fontSize: 12,
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      buttonPrimary: {
        border: 'none',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontWeight: 500,
        padding: '4px 12px',
        fontSize: 12,
        borderRadius: 8,
        cursor: 'pointer',
        flex: '0 0 auto',
        alignSelf: 'flex-start',
      },
      statusLine: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        margin: '0 0 16px',
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 12,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
      },
      cardName: {
        fontSize: 14,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      },
      cardNameText: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      cardMeta: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '2px 10px',
      },
      fileList: {
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      },
      fileRow: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      },
      fileDate: {
        color: 'var(--dsw-alias-state-idle-primary)',
        marginRight: 6,
        flex: '0 0 auto',
      },
      chipRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
      },
      chip: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        padding: '1px 6px',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      noProject: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      skills: {
        marginTop: 16,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: '12px 14px',
      },
      skillsTitle: {
        fontSize: 12,
        fontWeight: 600,
        marginBottom: 8,
      },
      skillRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 12,
        marginBottom: 6,
        flexWrap: 'wrap',
      },
      skillName: {
        fontWeight: 600,
        color: 'var(--dsw-alias-brand-primary)',
        flex: '0 0 auto',
      },
      skillHint: {
        color: 'var(--dsw-alias-label-secondary)',
      },
      skillsSubtitle: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        margin: '10px 0 6px',
        paddingTop: 8,
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      courseBlock: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        marginBottom: 10,
        overflow: 'hidden',
      },
      courseHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        cursor: 'pointer',
        userSelect: 'none',
      },
      courseName: {
        fontSize: 13,
        fontWeight: 600,
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      courseMeta: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        flex: '0 0 auto',
      },
      badgeOn: {
        fontSize: 12,
        color: 'var(--dsw-alias-state-success-primary, #2f9e44)',
        flex: '0 0 auto',
      },
      badge: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-caption)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 999,
        padding: '1px 8px',
        flex: '0 0 auto',
      },
      fileRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px 6px 20px',
        fontSize: 12,
        cursor: 'pointer',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      fileName: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      fileMeta: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-caption)',
        flex: '0 0 auto',
      },
      rowActions: {
        display: 'flex',
        gap: 8,
        padding: '8px 12px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      miniButton: {
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      footerBar: {
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        marginTop: 12,
        padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
      },
      cardActions: {
        display: 'flex',
        gap: 8,
        marginTop: 4,
      },
      reviewHint: {
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px dashed var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 10,
      },
      formatBtn: {
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      formatBtnOn: {
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        fontWeight: 600,
        cursor: 'pointer',
      },
      noticeOk: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
        flex: '1 1 100%',
      },
      noticeErr: {
        fontSize: 12,
        color: 'var(--dsw-alias-state-error-primary)',
        wordBreak: 'break-all',
        flex: '1 1 100%',
      },
      tabsRow: {
        display: 'flex',
        gap: 6,
        marginBottom: 12,
      },
      tab: {
        fontSize: 13,
        padding: '4px 14px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      tabOn: {
        fontSize: 13,
        padding: '4px 14px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        fontWeight: 600,
        cursor: 'pointer',
      },
      rootsRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        marginBottom: 10,
      },
      rootChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 999,
        padding: '2px 8px',
        maxWidth: '100%',
        overflow: 'hidden',
        cursor: 'pointer',
        background: 'transparent',
      },
      // The chip whose courses are currently listed.
      rootChipActive: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-brand-primary, #4f46e5)',
        borderRadius: 999,
        padding: '2px 8px',
        maxWidth: '100%',
        overflow: 'hidden',
        cursor: 'pointer',
        background: 'var(--dsw-alias-bg-l2, rgba(79, 70, 229, 0.12))',
      },
      rootName: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      chipClose: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-caption)',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1,
        padding: 0,
      },
      rootInput: {
        fontSize: 12,
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        flex: '1 1 240px',
        minWidth: 0,
      },
      message: {
        padding: '24px 0',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 13,
      },
    };

    function formatDateTime(iso, locale) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function truncate(text, max) {
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    function CourseCard({ course, t, locale, onOpen, onReview, onRemove }) {
      const latestRows = (course.latestFiles || []).map((file, index) =>
        h(
          'li',
          { key: index, style: s.fileRow },
          h('span', { style: s.fileDate }, formatDateTime(file.mtime, locale)),
          truncate(file.name, 34),
        ),
      );
      // One button, three states: the label tells you what the click will do.
      const label = course.sessionId
        ? tr(t, 'openCourseware')
        : course.workspaceId
          ? tr(t, 'openProject')
          : tr(t, 'createProject');
      return h(
        'div',
        { style: s.card },
        h(
          'div',
          { style: s.cardName },
          h('span', { style: s.cardNameText }, course.name),
          course.extra && onRemove
            ? h(
                'button',
                { style: s.chipClose, title: tr(t, 'removeCourse'), onClick: () => onRemove(course) },
                '×',
              )
            : null,
        ),
        h(
          'div',
          { style: s.cardMeta },
          h('span', null, tr(t, 'materials', course.courseFileCount)),
          course.subfolders && course.subfolders.length > 0
            ? h('span', null, tr(t, 'subfolders', course.subfolders.length))
            : null,
          course.lastModified
            ? h('span', null, tr(t, 'latestUpdate', formatDateTime(course.lastModified, locale)))
            : null,
        ),
        latestRows.length > 0 ? h('ul', { style: s.fileList }, latestRows) : null,
        course.subfolders && course.subfolders.length > 0
          ? h(
              'div',
              { style: s.chipRow },
              course.subfolders.slice(0, 3).map((folder, index) =>
                h('span', { key: index, style: s.chip }, `${folder.name} · ${folder.files}`),
              ),
            )
          : null,
        h(
          'div',
          { style: s.cardActions },
          h('button', { style: s.buttonPrimary, onClick: () => onOpen(course) }, label),
          // Review is the second door into the same course: pick files, then a
          // summary plus a full problem set with answers.
          h(
            'button',
            { style: s.button, onClick: () => onReview(course), title: tr(t, 'reviewHint') },
            tr(t, 'review'),
          ),
        ),
      );
    }

    function Panel({ t, locale, uiWorkspace }) {
      const [state, setState] = React.useState({ loading: true });
      const load = React.useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: '' }));
        fetch(OVERVIEW_URL, { cache: 'no-store' })
          .then((response) => response.json())
          .then((data) => {
            if (data && data.ok) {
              setState({ loading: false, data, error: '' });
            } else {
              setState({
                loading: false,
                error: (data && data.error) || 'bad response',
              });
            }
          })
          .catch(() => setState({ loading: false, error: 'network' }));
      }, []);
      React.useEffect(load, [load]);
      const [openError, setOpenError] = React.useState('');
      const [activePath, setActivePath] = React.useState('');
      const [activeMode, setActiveMode] = React.useState('notes');
      const [rootsOpen, setRootsOpen] = React.useState(false);
      const [rootDraft, setRootDraft] = React.useState('');
      // Which root the course grid is filtered to; '' means every root.
      const [activeRoot, setActiveRoot] = React.useState('');
      const [picking, setPicking] = React.useState(false);
      const [view, setView] = React.useState('courses');

      const courses = (state.data && state.data.courses) || [];
      const roots = (state.data && state.data.roots) || [];
      const active = courses.find((course) => course.path === activePath);

      /**
       * Courses belonging to the selected folder, or all of them.
       *
       * Courses added one by one live outside every root, so they stay visible
       * no matter which folder is selected — otherwise the only way to reach
       * them would be to switch the filter off.
       */
      const selectedRoot = roots.find(
        (root) => normalizePathKey(root.path) === normalizePathKey(activeRoot),
      );
      const visibleCourses =
        selectedRoot === undefined
          ? courses
          : courses.filter(
              (course) => isUnderRoot(selectedRoot.path, course.path) || course.extra === true,
            );

      /** Pick one folder in the OS chooser and add it to the course list. */
      const addCourse = () => {
        setPicking(true);
        setOpenError('');
        Promise.resolve(pickDirectory(uiWorkspace))
          .then((path) => {
            if (typeof path !== 'string' || path.length === 0) {
              setPicking(false);
              return undefined;
            }
            return fetch(COURSES_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'add', path }),
            })
              .then((response) => response.json())
              .then((data) => {
                setPicking(false);
                if (data && data.ok) load();
                else {
                  setOpenError(
                    `${tr(t, 'noticeErr')} ${(data && (data.message || data.error)) || 'unknown'}`,
                  );
                }
              });
          })
          .catch((error) => {
            setPicking(false);
            setOpenError(`${tr(t, 'noticeErr')} ${String((error && error.message) || error)}`);
          });
      };

      /** Drop one individually added course from the list (folder untouched). */
      const removeCourse = (course) => {
        fetch(COURSES_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'remove', path: course.path }),
        })
          .then((response) => response.json())
          .then((data) => {
            if (data && data.ok) load();
          })
          .catch(() => {});
      };

      /**
       * Enter one course: make sure a Session exists, then show that course's
       * courseware right here. `openWorkspace` reveals the conversation, so the
       * panel is selected again afterwards — one click lands on the file list.
       */
      /**
       * Enter one course: show its courseware right here.
       *
       * This is a browse-only step. It deliberately does not touch the
       * Workspace registry — a course folder only becomes a project once the
       * user asks for real work (generate a note, or ask a question), so the
       * sidebar does not grow an entry for every course someone glanced at.
       */
      const openCourse = (course, mode) => {
        setOpenError('');
        setActivePath(course.path);
        setActiveMode(mode);
        showPanel(PANEL_ID);
      };

      const editRoot = (action, path) => {
        fetch(ROOTS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, path }),
        })
          .then((response) => response.json())
          .then((data) => {
            if (data && data.ok) {
              setRootsOpen(false);
              setRootDraft('');
              setOpenError('');
              load();
            } else {
              setOpenError(`${tr(t, 'noticeErr')} ${(data && (data.message || data.error)) || 'unknown'}`);
            }
          })
          .catch(() => setOpenError(`${tr(t, 'noticeErr')} network`));
      };

      if (active !== undefined) {
        return h(CoursewareView, {
          course: active,
          mode: activeMode,
          t,
          uiWorkspace,
          onBack: () => {
            setActivePath('');
            load();
          },
          onRefresh: load,
        });
      }

      const header = h(
        'div',
        { style: s.header },
        h('h1', { style: s.title }, tr(t, 'title')),
        h('div', { style: s.rootPath }, state.data ? state.data.root : ''),
        h('button', { style: s.button, onClick: load, disabled: state.loading }, tr(t, 'refresh')),
        h(
          'button',
          { style: s.buttonPrimary, onClick: addCourse, disabled: picking },
          picking ? tr(t, 'picking') : tr(t, 'addCourse'),
        ),
      );

      const tabs = h(
        'div',
        { style: s.tabsRow },
        h(
          'button',
          { style: view === 'courses' ? s.tabOn : s.tab, onClick: () => setView('courses') },
          tr(t, 'tabCourses'),
        ),
        h(
          'button',
          { style: view === 'notes' ? s.tabOn : s.tab, onClick: () => setView('notes') },
          tr(t, 'tabNotes'),
        ),
      );

      if (view === 'notes') {
        return h(
          'div',
          { style: s.page },
          header,
          tabs,
          state.loading && !state.data ? h('div', { style: s.message }, tr(t, 'loading')) : null,
          state.error ? h('div', { style: s.message }, `${tr(t, 'loadFailed')}: ${state.error}`) : null,
          openError ? h('div', { style: s.message }, `${openError}`) : null,
          h(NotesView, {
            courses,
            t,
            locale,
            onEnterCourse: (course) => openCourse(course, 'notes'),
            uiWorkspace,
          }),
        );
      }

      return h(
        'div',
        { style: s.page },
        header,
        tabs,
        state.loading && !state.data
          ? h('div', { style: s.message }, tr(t, 'loading'))
          : null,
        state.error
          ? h('div', { style: s.message }, `${tr(t, 'loadFailed')}: ${state.error}`)
          : null,
        openError
          ? h('div', { style: s.message }, `${openError}`)
          : null,
        h(
          'div',
          { style: s.rootsRow },
          h(
            'button',
            {
              key: '__all__',
              style: activeRoot === '' ? s.rootChipActive : s.rootChip,
              onClick: () => setActiveRoot(''),
            },
            tr(t, 'allRoots'),
          ),
          roots.map((root) =>
            h(
              'div',
              {
                key: root.path,
                style:
                  normalizePathKey(root.path) === normalizePathKey(activeRoot)
                    ? s.rootChipActive
                    : s.rootChip,
                title: root.path,
                // Click to list only this folder's courses; click again to clear.
                onClick: () =>
                  setActiveRoot((prev) =>
                    normalizePathKey(prev) === normalizePathKey(root.path) ? '' : root.path,
                  ),
              },
              h('span', { style: s.rootName }, lastSegment(root.path)),
              root.removable
                ? h(
                    'button',
                    {
                      style: s.chipClose,
                      title: tr(t, 'removeRoot'),
                      onClick: (event) => {
                        event.stopPropagation();
                        editRoot('remove', root.path);
                      },
                    },
                    '×',
                  )
                : null,
            ),
          ),
          h(
            'button',
            { style: s.miniButton, onClick: () => setRootsOpen((prev) => !prev) },
            tr(t, 'addRoot'),
          ),
        ),
        rootsOpen
          ? h(
              'div',
              { style: s.rootsRow },
              h('input', {
                style: s.rootInput,
                value: rootDraft,
                placeholder: tr(t, 'rootPlaceholder'),
                onChange: (event) => setRootDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && rootDraft.trim().length > 0) {
                    editRoot('add', rootDraft.trim());
                  }
                },
              }),
              h(
                'button',
                {
                  style: s.miniButton,
                  disabled: rootDraft.trim().length === 0,
                  onClick: () => editRoot('add', rootDraft.trim()),
                },
                tr(t, 'confirm'),
              ),
            )
          : null,
        visibleCourses.length > 0
          ? h(
              'div',
              { style: s.grid },
              visibleCourses.map((course) =>
                h(CourseCard, {
                  key: course.path,
                  course,
                  t,
                  locale,
                  onOpen: (course) => openCourse(course, 'notes'),
                  onReview: (course) => openCourse(course, 'review'),
                  onRemove: removeCourse,
                }),
              ),
            )
          : null,
        state.data && visibleCourses.length === 0
          ? h(
              'div',
              { style: s.message },
              selectedRoot === undefined ? tr(t, 'noCourses') : tr(t, 'noCoursesInRoot'),
            )
          : null,
        state.data
          ? h('div', { style: s.statusLine }, tr(t, 'updatedAt', formatDateTime(state.data.generatedAt, locale)))
          : null,
        h(
          'div',
          { style: s.skills },
          h('div', { style: s.skillsTitle }, tr(t, 'skillsTitle')),
          h('div', { style: s.skillRow }, h('span', { style: s.skillName }, tr(t, 'cmdOutlineName')), h('span', { style: s.skillHint }, tr(t, 'cmdOutlineHint'))),
          h('div', { style: s.skillRow }, h('span', { style: s.skillName }, tr(t, 'cmdNotesName')), h('span', { style: s.skillHint }, tr(t, 'cmdNotesHint'))),
          h('div', { style: s.skillsSubtitle }, tr(t, 'skillsSubtitle')),
          h('div', { style: s.skillRow }, h('span', { style: s.skillName }, tr(t, 'skillReviewName')), h('span', { style: s.skillHint }, tr(t, 'skillReviewHint'))),
          h('div', { style: s.skillRow }, h('span', { style: s.skillName }, tr(t, 'skillDigestName')), h('span', { style: s.skillHint }, tr(t, 'skillDigestHint'))),
          h('div', { style: s.skillRow }, h('span', { style: s.skillName }, tr(t, 'skillAssignName')), h('span', { style: s.skillHint }, tr(t, 'skillAssignHint'))),
        ),
      );
    }

    /**
     * Watch for a note/outline the Host has queued for preview.
     *
     * The panel slot carries no Session binding, so the Host names the Session
     * in the payload and this hook simply opens whatever it hands back. The
     * icon that owns this hook lives in the always-mounted sidebar list, so the
     * preview opens even while the user is looking at the conversation.
     */
    function usePreviewWatcher() {
      React.useEffect(() => {
        // Browser only: the headless smoke test renders these components with
        // no document and must not keep a polling timer alive.
        if (typeof document === 'undefined' || typeof fetch !== 'function') return undefined;
        let stopped = false;
        let timer;
        let lastOpened = '';
        const poll = async () => {
          if (stopped) return;
          try {
            const response = await fetch(PREVIEW_URL, { headers: { accept: 'application/json' } });
            if (response.ok) {
              const payload = await response.json();
              if (
                payload &&
                payload.ok === true &&
                typeof payload.sessionId === 'string' &&
                typeof payload.path === 'string'
              ) {
                const address = previewAddress(payload.sessionId, payload.path);
                const result = tryPreview(payload.sessionId, payload.path);
                // Only a tab that really opened is acknowledged; otherwise the
                // Host keeps the entry and this poll retries (the conversation
                // may simply not be mounted right now).
                if (result.ok) {
                  if (address !== lastOpened) lastOpened = address;
                  fetch(
                    `${PREVIEW_URL}?ack=1&sessionId=${encodeURIComponent(payload.sessionId)}`,
                    { headers: { accept: 'application/json' } },
                  ).catch(() => {});
                }
              }
            }
          } catch {
            // Host restarting or offline; the next tick retries.
          }
          if (!stopped) timer = setTimeout(poll, PREVIEW_POLL_MS);
        };
        timer = setTimeout(poll, PREVIEW_POLL_MS);
        return () => {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
        };
      }, []);
    }

    /** Sidebar icon: a small graduation cap drawn with currentColor. */
    function SidebarIcon({ size }) {
      usePreviewWatcher();
      const px = size || 16;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: px,
          height: px,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          fill: 'currentColor',
          d: 'M12 4 1.5 9.2 12 14.4l8.6-4.3v5.1c0 .4.3.8.9.8s.9-.4.9-.8V9.2L12 4zm-6 9.1v3.1c0 1.5 2.7 2.8 6 2.8s6-1.3 6-2.8v-3.1l-6 3-6-3z',
        }),
      );
    }

    /** The message that turns a fresh conversation into this note's Q&A. */
    function noteChatPrompt(note) {
      return [
        '【笔记问答】只讨论这一篇笔记：',
        note.path,
        '',
        '先完整读它，再回答我的问题。回答以这篇笔记为准；需要展开的地方，可以回到同目录的课件里查证。',
        '不要重新生成笔记，也不要引用之前讨论过的其他笔记。',
      ].join('\n');
    }

    /** The message that moves an existing course Q&A conversation to another note. */
    function noteSwitchPrompt(note) {
      return [
        '现在切换到这一篇笔记：',
        note.path,
        '',
        '先读它，接下来的问题都围绕它；之前那篇笔记不再作为依据。',
      ].join('\n');
    }

    /** The sessions service, injected or looked up late. */
    function sessionsOf() {
      if (sessionsService !== undefined) return sessionsService;
      if (clientContext && typeof clientContext.get === 'function') {
        try {
          return clientContext.get('sessions');
        } catch {
          return undefined;
        }
      }
      return undefined;
    }

    /** Whether a Session id still exists in the Client's session list. */
    function sessionExists(sessionId) {
      const sessions = sessionsOf();
      if (sessions === undefined || sessions.list === undefined) return true;
      try {
        const snapshot = sessions.list.getSnapshot();
        return snapshot !== undefined && snapshot.byId !== undefined
          ? snapshot.byId[sessionId] !== undefined
          : true;
      } catch {
        return true;
      }
    }

    /**
     * Send one text block into a Session.
     *
     * `sessions.binding(id)` only answers for a Session this client has already
     * retained — a Session that was just created has no binding yet. `using`
     * retains one, waits for the Host to finish opening it, and hands back the
     * live binding, which is the only reliable way to reach a brand-new Session.
     */
    async function sendIntoSession(sessionId, text) {
      const sessions = sessionsOf();
      if (sessions === undefined) throw new Error('sessions 服务不可用');
      const deliver = async (binding) => {
        if (binding === undefined || binding.session === undefined) throw new Error('会话绑定不可用');
        if (typeof binding.session.prompt !== 'function') throw new Error('会话不支持发送');
        const result = await binding.session.prompt([{ type: 'text', text }], 'queue');
        if (result !== undefined && result.ok === false) {
          const reason = result.error && (result.error.message || result.error.code);
          throw new Error(reason || '发送失败');
        }
      };
      if (typeof sessions.using === 'function') {
        await sessions.using(sessionId, { source: 'course-workbench' }, async (reference) => {
          const binding =
            reference !== undefined && reference.ready !== undefined
              ? await reference.ready
              : reference && reference.binding;
          await deliver(binding);
        });
        return;
      }
      // Older shell: the mounted conversation may already hold the binding.
      const deadline = Date.now() + 3000;
      let binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined;
      while (binding === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        binding = sessions.binding(sessionId);
      }
      await deliver(binding);
    }

    /** The note path relative to its course root, spelled for a resource address. */
    function noteRelativePath(course, note) {
      if (!note.path.startsWith(course.path) || note.path.length <= course.path.length) {
        return note.path;
      }
      return note.path
        .slice(course.path.length)
        .replace(/^[\\/]+/, '')
        .split(/[\\/]/)
        .join('/');
    }

    /** Rename a Session the same way the sidebar's rename action does. */
    async function renameSession(sessionId, title) {
      const sessions = sessionsOf();
      if (sessions === undefined || typeof sessions.using !== 'function') return false;
      try {
        const result = await sessions.using(sessionId, { source: 'course-workbench' }, (reference) =>
          reference.binding.session.rename(title),
        );
        return !(result !== undefined && result.ok === false);
      } catch {
        return false;
      }
    }

    /** Persist which Session answers questions about a course's notes. */
    async function rememberNoteChat(coursePath, sessionId, notePath) {
      try {
        await fetch(NOTE_CHAT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ coursePath, sessionId, notePath }),
        });
      } catch {
        // The conversation still works; it just will not be found next time.
      }
    }

    /**
     * Open the Q&A conversation for one note, creating it the first time.
     *
     * One conversation per course: the first note asked about creates it, later
     * notes are announced into the same one so the thread stays findable. A
     * brand-new course simply gets its Session created on demand here — nothing
     * has to exist beforehand.
     */
    async function openNoteChat(course, note, uiWorkspace) {
      const relative = noteRelativePath(course, note);
      let known;
      try {
        const response = await fetch(`${NOTE_CHAT_URL}?course=${encodeURIComponent(course.path)}`, {
          headers: { accept: 'application/json' },
        });
        if (response.ok) known = await response.json();
      } catch {
        known = undefined;
      }

      const existing = known && typeof known.sessionId === 'string' ? known.sessionId : undefined;
      if (existing !== undefined && sessionExists(existing)) {
        // Open first: the mounted conversation is what keeps the Session alive
        // while the switch message is admitted, and it is what the user sees.
        uiWorkspace.openSession(existing);
        previewAfterMount(uiWorkspace, existing, relative, () => {});
        if (known.notePath !== note.path) {
          await sendIntoSession(existing, noteSwitchPrompt(note));
          await rememberNoteChat(course.path, existing, note.path);
        }
        return { ok: true, created: false };
      }

      const workspaceId = await ensureWorkspace(course);
      if (typeof uiWorkspace.connectWorkspace !== 'function') {
        // Older shell: leave the question in the composer instead of sending it.
        uiWorkspace.startSession(workspaceId, { prompt: noteChatPrompt(note) });
        return { ok: true, created: true, prefilled: true };
      }
      const sessionId = await uiWorkspace.connectWorkspace(workspaceId);
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('会话创建失败');
      }
      // Mount it before sending: `using` releases its own retention when the
      // send is admitted, and the mounted conversation is what outlives it.
      try {
        uiWorkspace.openSession(sessionId);
      } catch {
        // The send below still works; the user just lands on the panel.
      }
      // The note opens beside the conversation while the first message travels.
      previewAfterMount(uiWorkspace, sessionId, relative, () => {});
      await sendIntoSession(sessionId, noteChatPrompt(note));
      await rememberNoteChat(course.path, sessionId, note.path);
      // Name it so the sidebar says which conversation this is.
      await renameSession(sessionId, `${course.name} 笔记问答和期末复习`);
      return { ok: true, created: true };
    }

    /**
     * Notes view: generated deliverables grouped by course.
     *
     * A course row expands into its notes; clicking a note opens it in the
     * right sidebar. Preview addresses are Session-scoped, so a course without
     * a live conversation asks to enter the project first.
     */
    function NotesView({ courses, t, locale, onEnterCourse, uiWorkspace }) {
      const [openPath, setOpenPath] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [asking, setAsking] = React.useState('');

      const ordered = [
        ...courses.filter((course) => (course.notes || []).length > 0),
        ...courses.filter((course) => (course.notes || []).length === 0),
      ];

      const openNote = (course, note) => {
        if (course.sessionId === undefined) {
          setNotice({ kind: 'err', text: tr(t, 'noSessionNote') });
          return;
        }
        // Session resources resolve against the workspace root, so spell the
        // note relative to its course when possible (same as the Host route).
        const relative = noteRelativePath(course, note);
        setNotice({ kind: 'ok', text: tr(t, 'opening') });
        previewAfterMount(uiWorkspace, course.sessionId, relative, (result) => {
          setNotice(
            result.ok ? null : { kind: 'err', text: `${tr(t, 'previewFailed')} ${result.reason}` },
          );
        });
      };

      const ask = async (course, note) => {
        if (asking !== '') return;
        setAsking(note.path);
        setNotice({ kind: 'ok', text: tr(t, 'asking') });
        try {
          const result = await openNoteChat(course, note, uiWorkspace);
          setNotice(
            result.ok
              ? result.prefilled
                ? { kind: 'ok', text: tr(t, 'askPrefilled') }
                : null
              : { kind: 'err', text: tr(t, 'askFailed') },
          );
        } catch (error) {
          setNotice({
            kind: 'err',
            text: `${tr(t, 'askFailed')} ${String((error && error.message) || error)}`,
          });
        } finally {
          setAsking('');
        }
      };

      return h(
        'div',
        null,
        notice ? h('div', { style: s.noticeErr }, notice.text) : null,
        ordered.length === 0 ? h('div', { style: s.message }, tr(t, 'notesEmpty')) : null,
        ordered.map((course) => {
          const notes = course.notes || [];
          const expanded = openPath === course.path;
          return h(
            'div',
            { key: course.path, style: s.courseBlock },
            h(
              'div',
              {
                style: s.courseHead,
                onClick: () => setOpenPath(expanded ? '' : course.path),
              },
              h('span', { style: s.courseName }, course.name),
              h('span', { style: s.courseMeta }, tr(t, 'noteCount', String(notes.length))),
              course.noteChat ? h('span', { style: s.badge }, tr(t, 'noteChatBadge')) : null,
              course.sessionId
                ? h('span', { style: s.badgeOn }, '●')
                : h(
                    'button',
                    {
                      style: s.miniButton,
                      onClick: (event) => {
                        event.stopPropagation();
                        onEnterCourse(course);
                      },
                    },
                    course.workspaceId ? tr(t, 'openProject') : tr(t, 'createProject'),
                  ),
            ),
            expanded
              ? h(
                  'div',
                  null,
                  notes.length === 0
                    ? h('div', { key: 'empty', style: s.fileRow }, tr(t, 'noNotesYet'))
                    : notes.map((note) =>
                        h(
                          'div',
                          {
                            key: note.path,
                            style: s.fileRow,
                            title: note.path,
                            onClick: () => openNote(course, note),
                          },
                          h('span', { style: s.badge }, note.dir),
                          h('span', { style: s.fileName }, note.name),
                          h(
                            'span',
                            { style: s.fileMeta },
                            `${note.sizeKB}KB · ${formatDateTime(note.mtime, locale)}`,
                          ),
                          h(
                            'button',
                            {
                              style: s.miniButton,
                              title: tr(t, 'askNoteHint'),
                              onClick: (event) => {
                                event.stopPropagation();
                                ask(course, note);
                              },
                            },
                            asking === note.path ? tr(t, 'asking') : tr(t, 'askNote'),
                          ),
                        ),
                      ),
                )
              : null,
          );
        }),
      );
    }

    /**
     * One course's courseware, shown inside the same panel.
     *
     * The panel never reads files itself: it posts the ticked list to the Host,
     * which hands exactly those paths to the course's Session, so the model
     * sees a bounded task instead of a whole directory.
     */
    function CoursewareView({ course, mode, t, uiWorkspace, onBack, onRefresh }) {
      const [selected, setSelected] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const review = mode === 'review';

      const files = course.files || [];
      const chosen = Object.keys(selected).filter((path) => selected[path]);

      const toggleFile = (file) => {
        setSelected((prev) => ({ ...prev, [file.path]: !prev[file.path] }));
      };

      const toggleCourse = () => {
        const everyChosen = files.length > 0 && files.every((file) => selected[file.path]);
        const next = {};
        if (!everyChosen) for (const file of files) next[file.path] = true;
        setSelected(next);
      };

      /**
       * Create the course's project on demand.
       *
       * Browsing courseware needs no Session — the file list comes from the
       * Host — so opening a course must not register a Workspace. Only a real
       * generation does, and by then the Session is unavoidable.
       *
       * `openWorkspace` resolves before the Host has indexed the new agent, so
       * the caller still has to tolerate a `no-session` answer for a moment.
       */
      const ensureSession = () => {
        if (course.sessionId) return Promise.resolve();
        return Promise.resolve(adoptCourse(course, uiWorkspace));
      };

      /** POST the ticked files, retrying while the fresh Session propagates. */
      const dispatch = (attempt) => {
        fetch(GENERATE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ coursePath: course.path, files: chosen, mode }),
        })
          .then((response) => response.json())
          .then((data) => {
            if (
              data &&
              !data.ok &&
              data.error === 'no-session' &&
              attempt < 8
            ) {
              setTimeout(() => dispatch(attempt + 1), 700);
              return;
            }
            setBusy(false);
            if (data && data.ok) {
              setNotice({ kind: 'ok', text: `${tr(t, 'noticeOk')} ${data.target}` });
              // Review runs in the course's own Q&A conversation, so the title
              // has to say so — otherwise an older "笔记问答" session would keep
              // a name that no longer describes what lives in it.
              if (review && data.sessionId) {
                Promise.resolve(
                  renameSession(data.sessionId, `${course.name} 笔记问答和期末复习`),
                ).catch(() => {});
              }
              // The work happens in the conversation: go there once the Host
              // has accepted the task, so the run is visible.
              setTimeout(() => showPanel(null), 1500);
            } else {
              const detail = (data && (data.message || data.error)) || 'unknown';
              setNotice({ kind: 'err', text: `${tr(t, 'noticeErr')} ${detail}` });
            }
          })
          .catch(() => {
            setBusy(false);
            setNotice({ kind: 'err', text: `${tr(t, 'noticeErr')} network` });
          });
      };

      /** Generate: create the project first, but only when work is requested. */
      const generate = () => {
        if (chosen.length === 0) return;
        setBusy(true);
        setNotice(null);
        ensureSession()
          .then(() => dispatch(0))
          .catch((error) => {
            setBusy(false);
            setNotice({
              kind: 'err',
              text: `${tr(t, 'noticeErr')} ${String((error && error.message) || error)}`,
            });
          });
      };

      const rows = files.map((file) =>
        h(
          'label',
          { key: file.path, style: s.fileRow },
          h('input', {
            type: 'checkbox',
            checked: selected[file.path] === true,
            onChange: () => toggleFile(file),
          }),
          h('span', { style: s.fileName }, file.name),
          h('span', { style: s.fileMeta }, `${String(file.ext || '').toUpperCase()} · ${file.sizeKB}KB`),
        ),
      );

      return h(
        'div',
        { style: s.page },
        h(
          'div',
          { style: s.header },
          h('button', { style: s.miniButton, onClick: onBack }, tr(t, 'back')),
          h('h1', { style: s.title }, review ? `${course.name} · ${tr(t, 'review')}` : course.name),
          course.sessionId
            ? h('span', { style: s.badgeOn }, '●')
            : h(
                'button',
                {
                  style: s.miniButton,
                  onClick: () => {
                    Promise.resolve(adoptCourse(course, uiWorkspace))
                      .then(() => setTimeout(onRefresh, 1200))
                      .catch((error) =>
                        setNotice({
                          kind: 'err',
                          text: `${tr(t, 'noticeErr')} ${String((error && error.message) || error)}`,
                        }),
                      );
                  },
                },
                course.workspaceId ? tr(t, 'openProject') : tr(t, 'createProject'),
              ),
        ),
        h('div', { style: s.rootPath }, course.path),
        h(
          'div',
          { style: s.rowActions },
          h('button', { style: s.miniButton, onClick: toggleCourse }, tr(t, 'selectAll')),
          h('button', { style: s.miniButton, onClick: () => setSelected({}) }, tr(t, 'clearAll')),
          h('span', { style: s.courseMeta }, tr(t, 'filesCount', String(files.length))),
        ),
        review
          ? h('div', { style: s.reviewHint }, tr(t, 'reviewBody'))
          : null,
        files.length === 0 ? h('div', { style: s.message }, tr(t, 'noFiles')) : h('div', null, rows),
        h(
          'div',
          { style: s.footerBar },
          h('span', { style: s.courseMeta }, tr(t, 'outputBoth')),
          h(
            'button',
            { style: s.buttonPrimary, onClick: generate, disabled: busy || chosen.length === 0 },
            busy
              ? tr(t, 'generating')
              : review
                ? tr(t, 'generateReview', String(chosen.length))
                : tr(t, 'generate', String(chosen.length)),
          ),
          course.sessionId === undefined
            ? h('span', { style: s.noticeErr }, tr(t, 'noSessionHint'))
            : null,
          notice ? h('span', { style: notice.kind === 'ok' ? s.noticeOk : s.noticeErr }, notice.text) : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        clientContext = ctx;
        // The Right-Sidebar face is provided by the layout domain; resolve it
        // through `inject` so the preview watcher holds the real service.
        try {
          ctx.inject(['sidebarRight'], (scoped) => {
            sidebarRightService = scoped.sidebarRight;
          });
        } catch {
          // Older shells: the watcher falls back to `ctx.get`.
        }
        // Workspace registry: needed to adopt a brand-new course folder.
        try {
          ctx.inject(['workspaces'], (scoped) => {
            workspacesService = scoped.workspaces;
          });
        } catch {
          // Without it, "新建项目" degrades to the shipped workspace menu.
        }
        // Session registry: lets a note open its own Q&A conversation.
        try {
          ctx.inject(['sessions'], (scoped) => {
            sessionsService = scoped.sessions;
          });
        } catch {
          // The note Q&A button then reports that it cannot create one.
        }
        // Layout: lets the panel come back after a project jump, and hand the
        // view to the conversation once generation starts.
        try {
          ctx.inject(['layout'], (scoped) => {
            layoutService = scoped.layout;
          });
        } catch {
          // Without it the panel simply is not reselected.
        }
        // Dictionaries first: every visible string below flows through them.
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`);
        const t = ctx.locale.bind(NS);

        // The workspace jump service arrives with the UI domains; keep it
        // optional so the panel still renders without it.
        let uiWorkspace;
        try {
          ctx.inject(['uiWorkspace'], (scoped) => {
            uiWorkspace = scoped.uiWorkspace;
          });
        } catch {
          // Everything except the jump button works without it.
        }

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ t }),
            },
            () =>
              h(Panel, {
                t,
                locale: (ctx.locale && ctx.locale.getSnapshot && ctx.locale.getSnapshot().active) || 'zh',
                uiWorkspace,
              }),
          ),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 3,
              label: () => t('nav'),
              locale: NS,
            },
            (owner) => h(SidebarIcon, { size: owner && owner.size }),
          ),
        );
      },
    };
  },
});
