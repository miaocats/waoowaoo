import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiError } from '@/lib/api-errors'
import { buildDefaultTaskBillingInfo } from '@/lib/billing/task-policy'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import { prisma } from '../../helpers/prisma'
import { resetBillingState } from '../../helpers/db-reset'
import { createTestUser, seedBalance } from '../../helpers/billing-fixtures'

const queueState = vi.hoisted(() => ({
  mode: 'success' as 'success' | 'fail',
  errorMessage: 'queue add failed',
}))

vi.mock('@/lib/task/queues', () => ({
  addTaskJob: vi.fn(async () => {
    if (queueState.mode === 'fail') {
      throw new Error(queueState.errorMessage)
    }
    return { id: 'mock-job' }
  }),
}))

vi.mock('@/lib/task/publisher', () => ({
  publishTaskEvent: vi.fn(async () => ({})),
}))

describe('billing/submitter integration', () => {
  beforeEach(async () => {
    await resetBillingState()
    process.env.BILLING_MODE = 'ENFORCE'
    queueState.mode = 'success'
    queueState.errorMessage = 'queue add failed'
  })

  it('builds billing info server-side for billable task submission', async () => {
    const user = await createTestUser()
    await seedBalance(user.id, 10)

    const result = await submitTask({
      userId: user.id,
      locale: 'en',
      projectId: 'project-a',
      type: TASK_TYPE.VOICE_LINE,
      targetType: 'VoiceLine',
      targetId: 'line-a',
      payload: { maxSeconds: 5 },
    })

    expect(result.success).toBe(true)
    const task = await prisma.task.findUnique({ where: { id: result.taskId } })
    expect(task).toBeTruthy()
    const billing = task?.billingInfo as { billable?: boolean; source?: string } | null
    expect(billing?.billable).toBe(true)
    expect(billing?.source).toBe('task')
  })

  it('marks task as failed when balance is insufficient', async () => {
    const user = await createTestUser()
    await seedBalance(user.id, 0)

    const billingInfo = buildDefaultTaskBillingInfo(TASK_TYPE.VOICE_LINE, { maxSeconds: 10 })
    expect(billingInfo?.billable).toBe(true)

    await expect(
      submitTask({
        userId: user.id,
        locale: 'en',
        projectId: 'project-b',
        type: TASK_TYPE.VOICE_LINE,
        targetType: 'VoiceLine',
        targetId: 'line-b',
        payload: { maxSeconds: 10 },
        billingInfo,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' } satisfies Pick<ApiError, 'code'>)

    const task = await prisma.task.findFirst({
      where: {
        userId: user.id,
        type: TASK_TYPE.VOICE_LINE,
      },
      orderBy: { createdAt: 'desc' },
    })

    expect(task).toBeTruthy()
    expect(task?.status).toBe('failed')
    expect(task?.errorCode).toBe('INSUFFICIENT_BALANCE')
  })

  it('allows billable task submission without computed billingInfo in OFF mode (regression)', async () => {
    process.env.BILLING_MODE = 'OFF'
    const user = await createTestUser()

    const result = await submitTask({
      userId: user.id,
      locale: 'en',
      projectId: 'project-c',
      type: TASK_TYPE.IMAGE_CHARACTER,
      targetType: 'CharacterAppearance',
      targetId: 'appearance-c',
      payload: {},
    })

    expect(result.success).toBe(true)
    const task = await prisma.task.findUnique({ where: { id: result.taskId } })
    expect(task).toBeTruthy()
    expect(task?.errorCode).toBeNull()
    expect(task?.billingInfo).toBeNull()
  })

  it('keeps strict billingInfo validation in ENFORCE mode (regression)', async () => {
    process.env.BILLING_MODE = 'ENFORCE'
    const user = await createTestUser()
    await seedBalance(user.id, 10)

    await expect(
      submitTask({
        userId: user.id,
        locale: 'en',
        projectId: 'project-d',
        type: TASK_TYPE.IMAGE_CHARACTER,
        targetType: 'CharacterAppearance',
        targetId: 'appearance-d',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' } satisfies Pick<ApiError, 'code'>)

    const task = await prisma.task.findFirst({
      where: {
        userId: user.id,
        type: TASK_TYPE.IMAGE_CHARACTER,
      },
      orderBy: { createdAt: 'desc' },
    })

    expect(task).toBeTruthy()
    expect(task?.status).toBe('failed')
    expect(task?.errorCode).toBe('INVALID_PARAMS')
    expect(task?.errorMessage).toContain('missing server-generated billingInfo')
  })

  it('rolls back billing freeze and marks task failed when queue enqueue fails', async () => {
    const user = await createTestUser()
    await seedBalance(user.id, 10)
    queueState.mode = 'fail'
    queueState.errorMessage = 'queue unavailable'

    await expect(
      submitTask({
        userId: user.id,
        locale: 'en',
        projectId: 'project-e',
        type: TASK_TYPE.VOICE_LINE,
        targetType: 'VoiceLine',
        targetId: 'line-e',
        payload: { maxSeconds: 6 },
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' } satisfies Pick<ApiError, 'code'>)

    const task = await prisma.task.findFirst({
      where: {
        userId: user.id,
        type: TASK_TYPE.VOICE_LINE,
      },
      orderBy: { createdAt: 'desc' },
    })
    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })

    expect(task).toBeTruthy()
    expect(task?.status).toBe('failed')
    expect(task?.errorCode).toBe('ENQUEUE_FAILED')
    expect(task?.errorMessage).toContain('queue unavailable')
    expect(task?.billingInfo).toMatchObject({
      billable: true,
      status: 'rolled_back',
    })
    expect(balance?.balance).toBeCloseTo(10, 8)
    expect(balance?.frozenAmount).toBeCloseTo(0, 8)
    expect(await prisma.balanceFreeze.count()).toBe(1)
    const freeze = await prisma.balanceFreeze.findFirst({ orderBy: { createdAt: 'desc' } })
    expect(freeze?.status).toBe('rolled_back')
  })
})
