import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { prisma } from '../../lib/prisma';

type PreferenceModule = 'USER' | 'ORG' | 'WORKFLOW';
type PreferenceSubCategory = 'USER_ACC' | 'ORG_STR' | 'WORK_FLOW';
type PreferenceAction = 'ADDED' | 'REMOVED';

type PreferenceUpdateItem = {
  type: PreferenceAction;
  module: PreferenceModule;
  nodePath: string;
  levelsHash: string;
  remarks?: string;
};

type PreferenceNodeScope = {
  id: string;
  nodeName: string;
  nodePath: string;
  nodeType: string;
  levelCount: number;
  modules: Set<PreferenceModule>;
};

type PreferenceWorkflowOption = {
  id: string;
  nodeId: string;
  levelsHash: string;
  name: string;
  alias: string;
  module: string;
  subModule: string;
};

const PREFERENCE_MODULES: PreferenceModule[] = ['USER', 'ORG', 'WORKFLOW'];
const PREFERENCE_MODULE_TO_SUBCATEGORY: Record<
  PreferenceModule,
  PreferenceSubCategory
> = {
  USER: 'USER_ACC',
  ORG: 'ORG_STR',
  WORKFLOW: 'WORK_FLOW',
};
const SUBCATEGORY_TO_PREFERENCE_MODULE: Record<
  PreferenceSubCategory,
  PreferenceModule
> = {
  USER_ACC: 'USER',
  ORG_STR: 'ORG',
  WORK_FLOW: 'WORKFLOW',
};

const normalizePreferenceModule = (value: unknown): PreferenceModule | null => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return PREFERENCE_MODULES.includes(normalized as PreferenceModule)
    ? (normalized as PreferenceModule)
    : null;
};

const normalizePreferenceAction = (value: unknown): PreferenceAction | null => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return normalized === 'ADDED' || normalized === 'REMOVED'
    ? normalized
    : null;
};

const buildPreferenceHistoryPayload = (input: {
  preferenceId?: string | null;
  module: PreferenceModule;
  node: { id: string; nodeName: string; nodePath: string; nodeType: string };
  workflow: { id: string; levelsHash: string; name: string; alias: string };
}) => ({
  preferenceId: input.preferenceId ?? null,
  module: input.module,
  nodeId: input.node.id,
  nodeName: input.node.nodeName,
  nodePath: input.node.nodePath,
  nodeType: input.node.nodeType,
  workflowId: input.workflow.id,
  workflowName: input.workflow.name,
  workflowAlias: input.workflow.alias,
  levelsHash: input.workflow.levelsHash,
});

const buildPreferenceRemark = (input: {
  type: PreferenceAction;
  module: PreferenceModule;
  nodeName: string;
  nodePath: string;
  workflowName: string;
  workflowAlias: string;
}) =>
  input.type === 'ADDED'
    ? `Workflow preference set for ${input.module} on ${input.nodeName} (${input.nodePath}) to ${input.workflowName} (${input.workflowAlias}).`
    : `Workflow preference removed for ${input.module} on ${input.nodeName} (${input.nodePath}) from ${input.workflowName} (${input.workflowAlias}).`;

const getNodeLevelCount = (nodePath: string) => {
  const segments = String(nodePath || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  return Math.max(segments.length, 1);
};

class PreferenceService {
  private static async getVisibleNodesForSubCategory(
    tx: typeof prisma,
    userId: string,
    companyId: string,
    subCategory: PreferenceSubCategory,
  ) {
    const accesses = await tx.userAccess.findMany({
      where: {
        userId,
        companyId,
        role: {
          subCategory,
        },
        orgStructure: {
          status: 'ACTIVE',
        },
      },
      include: {
        orgStructure: {
          select: {
            nodePath: true,
          },
        },
      },
    });

    if (accesses.length === 0) {
      return [] as Array<{
        id: string;
        nodeName: string;
        nodePath: string;
        nodeType: string;
        levelCount: number;
      }>;
    }

    const nodePaths = accesses
      .filter((access) => access.accessCategory === 'NODE')
      .map((access) => access.orgStructure.nodePath);
    const immediateChildPaths = accesses
      .filter((access) => access.accessCategory === 'IMMEDIATE_CHILD')
      .map((access) => access.orgStructure.nodePath);
    const allChildPaths = accesses
      .filter((access) => access.accessCategory === 'ALL_CHILD')
      .map((access) => access.orgStructure.nodePath);

    const visibleNodes = await tx.orgStructure.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        OR: [
          {
            nodePath: {
              in: [...nodePaths, ...immediateChildPaths, ...allChildPaths],
            },
          },
          ...allChildPaths.map((path) => ({
            nodePath: { startsWith: `${path}.` },
          })),
          ...immediateChildPaths.map((path) => ({
            parent: { nodePath: path },
          })),
        ],
      },
      select: {
        id: true,
        nodeName: true,
        nodePath: true,
        nodeType: true,
      },
      orderBy: [{ nodePath: 'asc' }],
    });

    return visibleNodes.map((node) => ({
      id: node.id,
      nodeName: node.nodeName,
      nodePath: node.nodePath,
      nodeType: String(node.nodeType),
      levelCount: getNodeLevelCount(node.nodePath),
    }));
  }

  private static async getAccessiblePreferenceScopes(
    tx: typeof prisma,
    userId: string,
    companyId: string,
  ): Promise<PreferenceNodeScope[]> {
    const adminAccesses = await tx.userAccess.findMany({
      where: {
        userId,
        companyId,
        OR: [
          { isGlobalAccess: true },
          { roleCode: 'SAAS_ADMIN' },
          { roleCode: 'CORP_ADMIN' },
        ],
      },
      select: {
        id: true,
      },
    });

    if (adminAccesses.length > 0) {
      const nodes = await tx.orgStructure.findMany({
        where: {
          companyId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          nodeName: true,
          nodePath: true,
          nodeType: true,
        },
        orderBy: [{ nodePath: 'asc' }],
      });

      return nodes.map((node) => ({
        id: node.id,
        nodeName: node.nodeName,
        nodePath: node.nodePath,
        nodeType: String(node.nodeType),
        levelCount: getNodeLevelCount(node.nodePath),
        modules: new Set(PREFERENCE_MODULES),
      }));
    }

    const scopeByNodeId = new Map<string, PreferenceNodeScope>();

    for (const subCategory of Object.keys(
      SUBCATEGORY_TO_PREFERENCE_MODULE,
    ) as PreferenceSubCategory[]) {
      const module = SUBCATEGORY_TO_PREFERENCE_MODULE[subCategory];
      const nodes = await PreferenceService.getVisibleNodesForSubCategory(
        tx,
        userId,
        companyId,
        subCategory,
      );

      nodes.forEach((node) => {
        const existing = scopeByNodeId.get(node.id);
        if (existing) {
          existing.modules.add(module);
          return;
        }

        scopeByNodeId.set(node.id, {
          ...node,
          modules: new Set([module]),
        });
      });
    }

    return Array.from(scopeByNodeId.values()).sort((left, right) =>
      left.nodePath.localeCompare(right.nodePath),
    );
  }

  private static async getDefaultWorkflowMap(
    tx: typeof prisma,
    companyId: string,
  ) {
    const rows = await tx.workflow.findMany({
      where: {
        companyId,
        module: 'SYSTEM_ACCESS',
        subModule: {
          in: Object.values(PREFERENCE_MODULE_TO_SUBCATEGORY),
        },
        name: { contains: 'DEFAULT' },
        status: 'ACTIVE',
      },
      select: {
        id: true,
        nodeId: true,
        levelsHash: true,
        name: true,
        alias: true,
        module: true,
        subModule: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    const map = new Map<PreferenceModule, PreferenceWorkflowOption>();
    rows.forEach((row) => {
      const module = normalizePreferenceModule(
        SUBCATEGORY_TO_PREFERENCE_MODULE[
          row.subModule as PreferenceSubCategory
        ],
      );
      if (!module || map.has(module)) return;
      map.set(module, {
        id: row.id,
        nodeId: row.nodeId,
        levelsHash: row.levelsHash,
        name: row.name,
        alias: row.alias,
        module: row.module,
        subModule: row.subModule,
      });
    });

    return map;
  }

  private static async getNodeWorkflowRows(
    tx: typeof prisma,
    companyId: string,
    nodeIds: string[],
  ) {
    if (nodeIds.length === 0) {
      return [] as PreferenceWorkflowOption[];
    }

    const rows = await tx.workflow.findMany({
      where: {
        companyId,
        nodeId: { in: nodeIds },
        subModule: {
          in: Object.values(PREFERENCE_MODULE_TO_SUBCATEGORY),
        },
        status: 'ACTIVE',
        orgStructure: {
          status: 'ACTIVE',
        },
      },
      select: {
        id: true,
        nodeId: true,
        levelsHash: true,
        name: true,
        alias: true,
        module: true,
        subModule: true,
      },
      orderBy: [{ name: 'asc' }, { createdAt: 'desc' }],
    });

    return rows;
  }

  static async fetchUserWorkflowPreferences(params: {
    userId: string;
    companyId: string;
  }) {
    const scopes = await PreferenceService.getAccessiblePreferenceScopes(
      prisma,
      params.userId,
      params.companyId,
    );

    if (scopes.length === 0) {
      return {
        message: 'User workflow preferences fetched successfully!',
        code: 200,
        data: [],
      };
    }

    const nodeIds = scopes.map((scope) => scope.id);
    const [defaultWorkflowMap, nodeWorkflowRows, preferences] = await Promise.all(
      [
        PreferenceService.getDefaultWorkflowMap(prisma, params.companyId),
        PreferenceService.getNodeWorkflowRows(prisma, params.companyId, nodeIds),
        prisma.userWorkflowPreference.findMany({
          where: {
            companyId: params.companyId,
            userId: params.userId,
            nodeId: { in: nodeIds },
          },
          select: {
            id: true,
            module: true,
            nodeId: true,
            workflowId: true,
          },
        }),
      ],
    );

    const workflowsByNodeAndModule = new Map<string, PreferenceWorkflowOption[]>();
    nodeWorkflowRows.forEach((workflow) => {
      const subCategory = workflow.subModule as PreferenceSubCategory;
      const module = SUBCATEGORY_TO_PREFERENCE_MODULE[subCategory];
      if (!module) return;
      const key = `${workflow.nodeId}:${module}`;
      const existing = workflowsByNodeAndModule.get(key) || [];
      existing.push(workflow);
      workflowsByNodeAndModule.set(key, existing);
    });

    const preferenceByKey = new Map<string, (typeof preferences)[number]>();
    preferences.forEach((preference) => {
      const module = normalizePreferenceModule(preference.module);
      if (!module) return;
      preferenceByKey.set(`${preference.nodeId}:${module}`, preference);
    });

    const data = scopes.map((scope) => {
      const modules: Record<string, { workflows: Array<any> }> = {};

      PREFERENCE_MODULES.forEach((module) => {
        if (!scope.modules.has(module)) return;

        const key = `${scope.id}:${module}`;
        const nodeWorkflowOptions = workflowsByNodeAndModule.get(key) || [];
        const defaultWorkflow = defaultWorkflowMap.get(module) || null;
        const selectedPreference = preferenceByKey.get(key) || null;
        const selectedWorkflowId = selectedPreference?.workflowId || defaultWorkflow?.id || null;
        const workflowMap = new Map<string, PreferenceWorkflowOption>();

        if (defaultWorkflow) {
          workflowMap.set(defaultWorkflow.levelsHash, defaultWorkflow);
        }

        nodeWorkflowOptions.forEach((workflow) => {
          if (!workflowMap.has(workflow.levelsHash)) {
            workflowMap.set(workflow.levelsHash, workflow);
          }
        });

        modules[module] = {
          workflows: Array.from(workflowMap.values()).map((workflow) => ({
            levelsHash: workflow.levelsHash,
            name: workflow.name,
            alias: workflow.alias,
            selected: selectedWorkflowId === workflow.id,
          })),
        };
      });

      return {
        nodeName: scope.nodeName,
        nodePath: scope.nodePath,
        nodeType: scope.nodeType,
        levelCount: scope.levelCount,
        modules,
      };
    });

    return {
      message: 'User workflow preferences fetched successfully!',
      code: 200,
      data,
    };
  }

  static async updateWorkflowPreferences(params: {
    userId: string;
    companyId: string;
    eventUserId: string;
    preferences: PreferenceUpdateItem[];
  }) {
    const scopes = await PreferenceService.getAccessiblePreferenceScopes(
      prisma,
      params.userId,
      params.companyId,
    );
    const scopeByNodePath = new Map(scopes.map((scope) => [scope.nodePath, scope]));
    const requestedNodePaths = Array.from(
      new Set(
        params.preferences
          .map((preference) => preference.nodePath.trim())
          .filter(Boolean),
      ),
    );

    const nodes = await prisma.orgStructure.findMany({
      where: {
        companyId: params.companyId,
        status: 'ACTIVE',
        nodePath: { in: requestedNodePaths },
      },
      select: {
        id: true,
        nodeName: true,
        nodePath: true,
        nodeType: true,
      },
    });
    const nodeByPath = new Map(nodes.map((node) => [node.nodePath, node]));

    const [defaultWorkflowMap, nodeWorkflowRows, existingRows] = await Promise.all([
      PreferenceService.getDefaultWorkflowMap(prisma, params.companyId),
      PreferenceService.getNodeWorkflowRows(
        prisma,
        params.companyId,
        nodes.map((node) => node.id),
      ),
      prisma.userWorkflowPreference.findMany({
        where: {
          companyId: params.companyId,
          userId: params.userId,
          nodeId: { in: nodes.map((node) => node.id) },
        },
        include: {
          node: {
            select: {
              id: true,
              nodeName: true,
              nodePath: true,
              nodeType: true,
            },
          },
          workflow: {
            select: {
              id: true,
              levelsHash: true,
              name: true,
              alias: true,
            },
          },
        },
      }),
    ]);

    const workflowByNodeModuleHash = new Map<string, PreferenceWorkflowOption>();
    nodeWorkflowRows.forEach((workflow) => {
      const module =
        SUBCATEGORY_TO_PREFERENCE_MODULE[
          workflow.subModule as PreferenceSubCategory
        ];
      if (!module) return;
      workflowByNodeModuleHash.set(
        `${workflow.nodeId}:${module}:${workflow.levelsHash}`,
        workflow,
      );
    });

    const existingByKey = new Map(
      existingRows.map((row) => [`${row.nodeId}:${row.module}`, row]),
    );

    const updated = await prisma.$transaction(async (tx) => {
      const results: Array<{
        type: PreferenceAction;
        module: PreferenceModule;
        nodePath: string;
        levelsHash: string;
        workflowId?: string | null;
        preferenceId?: string | null;
      }> = [];

      for (const rawPreference of params.preferences) {
        const type = normalizePreferenceAction(rawPreference.type);
        const module = normalizePreferenceModule(rawPreference.module);
        const nodePath = String(rawPreference.nodePath || '').trim();
        const levelsHash = String(rawPreference.levelsHash || '').trim();

        if (!type || !module || !nodePath || !levelsHash) {
          throw new AppError('Invalid workflow preference payload', 400);
        }

        const node = nodeByPath.get(nodePath);
        if (!node) {
          throw new AppError(`Node '${nodePath}' not found`, 404);
        }

        const scope = scopeByNodePath.get(nodePath);
        if (!scope || !scope.modules.has(module)) {
          throw new AppError(
            `You do not have ${module} access for node '${nodePath}'`,
            403,
          );
        }

        const resolvedWorkflow =
          workflowByNodeModuleHash.get(`${node.id}:${module}:${levelsHash}`) ||
          (defaultWorkflowMap.get(module)?.levelsHash === levelsHash
            ? defaultWorkflowMap.get(module) || null
            : null);

        if (type === 'ADDED' && !resolvedWorkflow) {
          throw new AppError(
            `Workflow '${levelsHash}' is not available for ${module} on node '${nodePath}'`,
            400,
          );
        }

        const rowKey = `${node.id}:${module}`;
        const existing = existingByKey.get(rowKey) || null;

        if (type === 'ADDED' && resolvedWorkflow) {
          const oldData =
            existing && existing.workflow && existing.node
              ? buildPreferenceHistoryPayload({
                  preferenceId: existing.id,
                  module,
                  node: {
                    id: existing.node.id,
                    nodeName: existing.node.nodeName,
                    nodePath: existing.node.nodePath,
                    nodeType: String(existing.node.nodeType),
                  },
                  workflow: existing.workflow,
                })
              : null;

          if (existing && existing.workflowId === resolvedWorkflow.id) {
            continue;
          }

          const saved = existing
            ? await tx.userWorkflowPreference.update({
                where: { id: existing.id },
                data: {
                  workflowId: resolvedWorkflow.id,
                },
                include: {
                  node: {
                    select: {
                      id: true,
                      nodeName: true,
                      nodePath: true,
                      nodeType: true,
                    },
                  },
                  workflow: {
                    select: {
                      id: true,
                      levelsHash: true,
                      name: true,
                      alias: true,
                    },
                  },
                },
              })
            : await tx.userWorkflowPreference.create({
                data: {
                  companyId: params.companyId,
                  userId: params.userId,
                  module,
                  nodeId: node.id,
                  workflowId: resolvedWorkflow.id,
                },
                include: {
                  node: {
                    select: {
                      id: true,
                      nodeName: true,
                      nodePath: true,
                      nodeType: true,
                    },
                  },
                  workflow: {
                    select: {
                      id: true,
                      levelsHash: true,
                      name: true,
                      alias: true,
                    },
                  },
                },
              });

          const newData = buildPreferenceHistoryPayload({
            preferenceId: saved.id,
            module,
            node: {
              id: saved.node.id,
              nodeName: saved.node.nodeName,
              nodePath: saved.node.nodePath,
              nodeType: String(saved.node.nodeType),
            },
            workflow: saved.workflow,
          });
          const remarks =
            rawPreference.remarks?.trim() ||
            buildPreferenceRemark({
              type: 'ADDED',
              module,
              nodeName: saved.node.nodeName,
              nodePath: saved.node.nodePath,
              workflowName: saved.workflow.name,
              workflowAlias: saved.workflow.alias,
            });

          await tx.userWorkflowPreferenceHistory.create({
            data: {
              preferenceId: saved.id,
              companyId: params.companyId,
              eventUserId: params.eventUserId,
              oldData: oldData ?? Prisma.JsonNull,
              newData,
              remarks,
            },
          });

          existingByKey.set(rowKey, saved);
          results.push({
            type,
            module,
            nodePath: saved.node.nodePath,
            levelsHash: saved.workflow.levelsHash,
            workflowId: saved.workflow.id,
            preferenceId: saved.id,
          });
          continue;
        }

        if (!existing || !existing.workflow || !existing.node) {
          continue;
        }

        const oldData = buildPreferenceHistoryPayload({
          preferenceId: existing.id,
          module,
          node: {
            id: existing.node.id,
            nodeName: existing.node.nodeName,
            nodePath: existing.node.nodePath,
            nodeType: String(existing.node.nodeType),
          },
          workflow: existing.workflow,
        });
        const remarks =
          rawPreference.remarks?.trim() ||
          buildPreferenceRemark({
            type: 'REMOVED',
            module,
            nodeName: existing.node.nodeName,
            nodePath: existing.node.nodePath,
            workflowName: existing.workflow.name,
            workflowAlias: existing.workflow.alias,
          });

        await tx.userWorkflowPreference.delete({
          where: { id: existing.id },
        });
        await tx.userWorkflowPreferenceHistory.create({
          data: {
            preferenceId: null,
            companyId: params.companyId,
            eventUserId: params.eventUserId,
            oldData,
            newData: Prisma.JsonNull,
            remarks,
          },
        });

        existingByKey.delete(rowKey);
        results.push({
          type,
          module,
          nodePath: existing.node.nodePath,
          levelsHash: existing.workflow.levelsHash,
          workflowId: existing.workflow.id,
          preferenceId: null,
        });
      }

      return results;
    });

    return {
      message: 'Workflow preferences updated successfully!',
      code: 200,
      data: updated,
    };
  }
}

export class PreferenceDbController {
  static async fetchUserPreferences(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { userId, companyId } = req.body;

      if (!userId || !companyId) {
        return res.status(400).json({ error: 'userId and companyId required' });
      }

      const result = await PreferenceService.fetchUserWorkflowPreferences({
        userId,
        companyId,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }

  static async updateWorkflowPreferences(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { userId, companyId, eventUserId, preferences } = req.body;

      if (!userId || !companyId || !eventUserId) {
        return res
          .status(400)
          .json({ error: 'userId, companyId and eventUserId required' });
      }

      if (!Array.isArray(preferences) || preferences.length === 0) {
        return res
          .status(400)
          .json({ error: 'preferences array is required' });
      }

      const result = await PreferenceService.updateWorkflowPreferences({
        userId,
        companyId,
        eventUserId,
        preferences,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }
}
