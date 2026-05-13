import { Status } from '@prisma/client';
import { prisma } from '../lib/prisma';

interface TargetNode {
  id: string;
  nodePath: string;
}

interface ResolvedTargetNodes {
  nodes: TargetNode[];
  unresolved: string[];
}

export class NodeAccessUtil {
  private static readonly NODE_SCOPED_INITIATE_MODULES = new Set([
    'ORG_STR',
    'USER_ACC',
    'WORK_FLOW',
  ]);

  /**
   * Verifies if a user has 'initiate' permission for the specific node(s)
   * involved in a request. Node-scoped initiation never falls back to a broad
   * module permission when the target node cannot be resolved.
   */
  static async verifyInitiationAccess(
    userId: string,
    companyId: string,
    module: string,
    body: any,
  ): Promise<boolean> {
    try {
      const { nodes, unresolved } = await this.resolveTargetNodes(
        companyId,
        module,
        body,
      );

      if (unresolved.length > 0) {
        console.warn(
          `[NodeAccess] Unable to resolve initiate node(s) for module ${module}: ${unresolved.join(', ')}`,
        );
        return false;
      }

      if (nodes.length === 0) {
        if (this.NODE_SCOPED_INITIATE_MODULES.has(module)) {
          console.warn(
            `[NodeAccess] Missing node context for '${module}' initiate request`,
          );
          return false;
        }

        return this.hasCompanyInitiateAccess(userId, companyId, module);
      }

      const accessRecords = await this.getInitiateAccessRecords(
        userId,
        companyId,
        module,
      );

      const hasEveryNode = nodes.every((node) =>
        accessRecords.some((access: any) => this.coversNode(access, node)),
      );

      if (!hasEveryNode) {
        console.warn(
          `[NodeAccess] User ${userId} denied 'initiate' for ${module} node(s): ${nodes
            .map((node) => node.nodePath)
            .join(', ')}`,
        );
      }

      return hasEveryNode;
    } catch (error) {
      console.error(
        '[NodeAccess] Error during initiation access check:',
        error,
      );
      return false;
    }
  }

  /**
   * Extracts and resolves relevant nodes from the request body based on module.
   */
  private static async resolveTargetNodes(
    companyId: string,
    module: string,
    body: any,
  ): Promise<ResolvedTargetNodes> {
    const identifiers = new Set<string>();
    const data = body?.data ?? {};

    const addIdentifier = (value: unknown) => {
      if (typeof value === 'string' && value.trim()) {
        identifiers.add(value.trim());
      }
    };

    if (module === 'ORG_STR') {
      const parentNode = body?.parentNode ?? data?.parentNode ?? {};
      addIdentifier(body?.parentId);
      addIdentifier(data?.parentId);
      addIdentifier(parentNode?.id);
      addIdentifier(parentNode?.nodeId);
      addIdentifier(parentNode?.nodePath);
      addIdentifier(body?.nodeId);
      addIdentifier(data?.nodeId);
      addIdentifier(body?.nodePath);
      addIdentifier(data?.nodePath);
    } else if (module === 'WORK_FLOW') {
      addIdentifier(body?.nodeId);
      addIdentifier(data?.nodeId);
      addIdentifier(body?.nodePath);
      addIdentifier(data?.nodePath);
    } else if (module === 'USER_ACC') {
      const permissions = Array.isArray(body?.permissions)
        ? body.permissions
        : Array.isArray(data?.permissions)
          ? data.permissions
          : [];

      for (const permission of permissions) {
        addIdentifier(permission?.nodeId);
        addIdentifier(permission?.nodePath);
      }
    } else {
      addIdentifier(body?.nodeId);
      addIdentifier(data?.nodeId);
      addIdentifier(body?.nodePath);
      addIdentifier(data?.nodePath);
    }

    const resolvedNodes = new Map<string, TargetNode>();
    const unresolved: string[] = [];

    for (const identifier of identifiers) {
      const node = await prisma.orgStructure.findFirst({
        where: this.isUUID(identifier)
          ? { id: identifier, companyId }
          : { nodePath: identifier, companyId },
        select: { id: true, nodePath: true },
      });

      if (!node) {
        unresolved.push(identifier);
        continue;
      }

      resolvedNodes.set(node.id, node);
    }

    return {
      nodes: Array.from(resolvedNodes.values()),
      unresolved,
    };
  }

  private static async hasCompanyInitiateAccess(
    userId: string,
    companyId: string,
    module: string,
  ): Promise<boolean> {
    const access = await prisma.userAccess.findFirst({
      where: {
        userId,
        companyId,
        user: {
          userMappings: {
            some: { companyId, status: Status.ACTIVE },
          },
        },
        OR: [
          { roleCode: 'SAAS_ADMIN' },
          { isGlobalAccess: true },
          {
            role: {
              subCategory: module,
              initiate: true,
            },
          },
        ],
      },
    });

    return !!access;
  }

  private static async getInitiateAccessRecords(
    userId: string,
    companyId: string,
    module: string,
  ) {
    return prisma.userAccess.findMany({
      where: {
        userId,
        companyId,
        user: {
          userMappings: {
            some: { companyId, status: Status.ACTIVE },
          },
        },
        OR: [
          { roleCode: 'SAAS_ADMIN' },
          { isGlobalAccess: true },
          {
            role: {
              subCategory: module,
              initiate: true,
            },
          },
        ],
      },
      include: {
        orgStructure: {
          select: { id: true, nodePath: true },
        },
        role: {
          select: {
            subCategory: true,
            initiate: true,
          },
        },
      },
    });
  }

  private static coversNode(access: any, targetNode: TargetNode): boolean {
    if (access.roleCode === 'SAAS_ADMIN' || access.isGlobalAccess) {
      return true;
    }

    if (!access.role?.initiate || !access.orgStructure?.nodePath) {
      return false;
    }

    const accessPath = access.orgStructure.nodePath;
    const targetPath = targetNode.nodePath;

    switch (access.accessCategory) {
      case 'ALL_CHILD':
        return (
          targetPath === accessPath || targetPath.startsWith(`${accessPath}.`)
        );

      case 'IMMEDIATE_CHILD':
        return (
          targetPath === accessPath ||
          this.getParentPath(targetPath) === accessPath
        );

      case 'NODE':
      default:
        return targetNode.id === access.nodeId;
    }
  }

  private static getParentPath(nodePath: string): string | null {
    const parts = nodePath.split('.');
    if (parts.length <= 1) {
      return null;
    }

    return parts.slice(0, -1).join('.');
  }

  private static isUUID(val: unknown): boolean {
    if (typeof val !== 'string') {
      return false;
    }

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(val);
  }
}
