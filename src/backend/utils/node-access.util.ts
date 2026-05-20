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

/**
 * NodeAccessUtil:
 * This utility centralizes the logic for hierarchical, node-scoped access control.
 *
 * Why we implement this:
 * 1. Granular Permissions: Our system requires permissions to be restricted to specific parts
 *    of the organizational hierarchy (e.g., a manager only having access to their department).
 * 2. Multi-Context Logic: Different modules (ORG_STR, USER_ACC, etc.) store node information
 *    differently in request bodies. This utility abstracts that complexity.
 * 3. Inheritance Support: It handles 'ltree' based path logic, allowing for permissions
 *    that can apply to a node and its descendants (ALL_CHILD) or just direct children (IMMEDIATE_CHILD).
 */
export class NodeAccessUtil {
  private static readonly NODE_SCOPED_INITIATE_MODULES = new Set([
    'ORG_STR',
    'USER_ACC',
    'WORK_FLOW',
  ]);

  /**
   * Verifies if a user has 'initiate' permission for the specific node(s) involved in a request.
   *
   * Logic:
   * - First, it resolves "target nodes" from the request body (e.g., where a user is being created).
   * - For security-critical modules (NODE_SCOPED_INITIATE_MODULES), it enforces that a valid
   *   node context MUST be present.
   * - It then matches these target nodes against the user's assigned access records,
   *   considering the hierarchy rules (coversNode).
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
        // Discovery-style requests may not carry a target node yet. In that
        // case, allow any active primary or secondary module access that can
        // initiate, plus global access and SAAS_ADMIN.
        const hasModuleAccess = await this.hasAnyInitiateAccess(
          userId,
          companyId,
          module,
        );

        if (hasModuleAccess) {
          return true;
        }

        // Only enforce node-scoped restriction if the user has no initiate access.
        if (this.NODE_SCOPED_INITIATE_MODULES.has(module)) {
          console.warn(
            `[NodeAccess] Missing node context for '${module}' initiate request and user ${userId} lacks initiate access`,
          );
          return false;
        }

        return false;
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
   *
   * Why this logic is complex:
   * Each module has a different payload structure. For example:
   * - ORG_STR: Looks for parentNode.nodePath to verify where a new node is being added.
   * - USER_ACC: Scans an array of permissions because a user might be assigned to multiple nodes.
   * - WORK_FLOW: Typically has a single nodePath context.
   *
   * It resolves dot-separated node paths to ensure consistency.
   */
  private static async resolveTargetNodes(
    companyId: string,
    module: string,
    body: any,
  ): Promise<ResolvedTargetNodes> {
    const identifiers = new Set<string>();
    const data = body?.data ?? {};

    const addFirstIdentifier = (...values: unknown[]) => {
      for (const value of values) {
        const identifier = this.normalizeNodeIdentifier(value);
        if (identifier) {
          identifiers.add(identifier);
          return;
        }
      }
    };

    if (module === 'ORG_STR') {
      // The frontend sends parent context as parentNode.nodePath for org creates.
      addFirstIdentifier(
        body?.parentNode,
        data?.parentNode,
        body?.node,
        data?.node,
        body?.nodePath,
        data?.nodePath,
      );
    } else if (module === 'WORK_FLOW') {
      addFirstIdentifier(body, data, body?.nodePath, data?.nodePath);
    } else if (module === 'USER_ACC') {
      const permissions = Array.isArray(body?.permissions)
        ? body.permissions
        : Array.isArray(data?.permissions)
          ? data.permissions
          : [];

      for (const permission of permissions) {
        addFirstIdentifier(
          permission,
          permission?.node,
          permission?.orgStructure,
        );
      }
    } else {
      addFirstIdentifier(body, data, body?.nodePath, data?.nodePath);
    }

    const resolvedNodes = new Map<string, TargetNode>();
    const unresolved: string[] = [];

    for (const identifier of identifiers) {
      const node = await prisma.orgStructure.findFirst({
        where: { nodePath: identifier, companyId },
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

  private static async hasAnyInitiateAccess(
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
      select: { id: true },
    });

    return !!access;
  }

  private static normalizeNodeIdentifier(value: unknown): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed || null;
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    const node = value as Record<string, unknown>;
    return this.normalizeNodeIdentifier(node.nodePath);
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

  /**
   * Evaluates if a specific UserAccess record covers a target node based on hierarchical rules.
   *
   * The logic implements three types of scoping:
   * 1. ALL_CHILD: Permission propagates to the node and all its descendants using path prefix matching.
   * 2. IMMEDIATE_CHILD: Permission applies to the node and its direct children only.
   * 3. NODE: Permission is strictly limited to that specific node.
   *
   * Global access (SAAS_ADMIN/isGlobalAccess) bypasses these checks.
   */
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
}
