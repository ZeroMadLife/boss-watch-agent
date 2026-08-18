export const NS = 'boss-watch.resume' as const

export const zh = {
  'action.import': '导入简历',
  'action.importing': '正在导入简历',
  'status.staged': '简历已暂存，请发送输入框中的预览请求',
  'error.upload': '简历暂存失败：{code}',
  'signal.action.import': '导入招聘邮件',
  'signal.action.importing': '正在导入招聘邮件',
  'signal.status.staged': '招聘邮件已暂存，请发送输入框中的预览请求',
  'signal.error.upload': '招聘邮件暂存失败：{code}',
} as const

export const en = {
  'action.import': 'Import resume',
  'action.importing': 'Importing resume',
  'status.staged': 'Resume staged; send the preview request in the composer',
  'error.upload': 'Resume staging failed: {code}',
  'signal.action.import': 'Import recruiting email',
  'signal.action.importing': 'Importing recruiting email',
  'signal.status.staged': 'Recruiting email staged; send the preview request in the composer',
  'signal.error.upload': 'Recruiting email staging failed: {code}',
} as const

export type ResumeKey = keyof typeof zh
