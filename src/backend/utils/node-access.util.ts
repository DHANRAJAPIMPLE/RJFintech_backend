import { prisma } from '../lib/prisma';
import { Status } from '@prisma/client';

export class NodeAccessUtil {
  /**
   * Verifies if a user has 'initiate' permission for the specific node(s) 
   * involved in a request.
   */
  static async verifyInitiationAccess(
    userId: string,
    companyId: string,
    module: string,
    body: any,
  ): Promise<boolean> {
    try {
      // 1. Resolve target nodes based on module logic
      const targetNodeIds = await this.resolveTargetNodeIds(companyId, module, body);

      // If no node context is found, we fall back to the general module-level check 
      // (handled by the caller) or allow it if the module doesn't require node context.
      if (targetNodeIds.length === 0) {
        return true; 
      }

      // 2. Check if user has initiate permission for ALL target nodes
      // (A global admin or global access user bypasses this)
      for (const nodeId of targetNodeIds) {
        const hasAccess = await prisma.userAccess.findFirst({
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
                nodeId,
                role: {
                  subCategory: module,
                  initiate: true,
                },
              },
            ],
          },
        });

        if (!hasAccess) {
          console.warn(`[NodeAccess] User ${userId} denied 'initiate' for node ${nodeId} in module ${module}`);
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error('[NodeAccess] Error during initiation access check:', error);
      return false;
    }
  }

  /**
   * Extracts relevant node IDs from the request body based on the module.
   */
  private static async resolveTargetNodeIds(
    companyId: string,
    module: string,
    body: any,
  ): Promise<string[]> {
    const nodes = new Set<string>();

    // Helper to resolve ID from path or ID
    const resolve = async (val: any) => {
      if (!val) return;
      if (this.isUUID(val)) {
        nodes.add(val);
      } else {
        const node = await prisma.orgStructure.findFirst({
          where: { companyId, nodePath: val },
          select: { id: true },
        });
        if (node) nodes.add(node.id);
      }
    };

    if (module === 'ORG_STR') {
      // For creating a node: parentId is the target
      await resolve(body.parentId);
      // For updating/deleting: nodeId or nodePath
      await resolve(body.nodeId);
      await resolve(body.nodePath);
    } else if (module === 'WORK_FLOW') {
      await resolve(body.nodeId);
    } else if (module === 'USER_ACC') {
      // For user onboarding: check all nodes in permissions array
      if (Array.isArray(body.permissions)) {
        for (const perm of body.permissions) {
          await resolve(perm.nodeId);
          await resolve(perm.nodePath);
        }
      }
    }

    return Array.from(nodes);
  }

  private static isUUID(val: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return typeof val === 'string' && uuidRegex.test(val);
  }
}
