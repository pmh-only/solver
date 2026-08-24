import { beforeEach } from 'vitest'

beforeEach(() => {
  process.env.ADMIN_USER_IDS = '666666666666666666'
  process.env.AGENT_TZ = 'Asia/Seoul'
})
