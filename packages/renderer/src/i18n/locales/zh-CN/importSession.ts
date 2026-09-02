/**
 * 导入会话对话框文案（import-session U5）。
 * 错误 key 与 shared ImportErrorCode 一一对应（+ transport timeout / unknown 兜底），
 * 新增错误码必须同步补两侧文案（composable FAILURE_CODES 集合同步维护）。
 */
export default {
  title: '导入会话',
  description: '从 pi 全局会话目录导入历史会话，导入后可继续对话',
  searchPlaceholder: '搜索名称或 Session ID（支持 01a044 式短 ID），或粘贴 .jsonl 绝对路径',
  allDirs: '全部目录',
  chooseDirBtn: '选择其他目录',
  chooseDirTitle: '选择 sessions 目录',
  sessionCount: '可见 {visible} / 共 {total}',
  dirScanHint: '扫描范围：顶层与一层子目录，更深层不会收录',
  group: {
    today: '今天',
    yesterday: '昨天',
    thisWeek: '本周',
    earlier: '更早',
  },
  importedBadge: '已导入',
  cwdMissing: '原目录已不存在，续聊将在主目录执行',
  importTo: '导入到',
  cancel: '取消',
  importBtn: '导入',
  importing: '导入中…',
  defaultProjectName: '默认项目',
  loading: '加载中…',
  emptyResult: '未找到匹配的会话文件',
  pathImportBtn: '导入此文件',
  pathNoMatch: '未找到匹配的 session 文件',
  loadFailed: '候选列表加载失败',
  retry: '重试',
  toastSidecarFailed: '会话已导入，但项目归属写入失败：请在侧边栏手动将该会话归类到项目',
  errors: {
    import_source_missing: '源文件不存在或不可读：请确认文件未被移动或删除后重试，或用「选择其他目录」重新定位 sessions 目录',
    import_invalid_session: '不是有效的 pi 会话文件（首行缺少 session header）：请选择 pi 产生的 .jsonl 会话文件',
    import_marker_filename: '文件名含迁移临时标记（.tmp-migrate- / .tmp-import-），疑似迁移残留：请选择原始会话文件',
    import_dir_unreadable: '目录不可读（权限不足）：请检查目录权限后重试，或用「选择其他目录」重新指定',
    import_already_imported: '该会话已导入过：侧边栏可直接打开',
    import_target_conflict: '目标位置已被另一会话占用：请处理冲突文件后重试',
    import_copy_failed: '复制会话文件失败（磁盘空间或权限问题）：请清理磁盘或检查权限后重试',
    import_project_invalid: '目标项目无效：请重新选择项目后重试',
    timeout: '请求超时：请重试',
    unknown: '导入失败：请重试',
  },
}
