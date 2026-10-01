// 素材库部署的成员名额限制；管理员和访客不占普通成员名额。
export function assertStudioMemberLimit(users: any[], env: any): void {
  const raw = env?.STUDIO_MEMBER_LIMIT
  if (raw === undefined || raw === "") return
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid STUDIO_MEMBER_LIMIT configuration")
  }
  const count = users.filter(user => Number(user.role) === 0 && !user.disabled).length
  if (count > limit) throw new Error(`最多启用 ${limit} 个成员账号；请先停用一位成员。`)
}
