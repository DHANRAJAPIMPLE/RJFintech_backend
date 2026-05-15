import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

// ─── Sanitization Helpers ────────────────────────────────────────────────────

const cleanString = (value: unknown) => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const isUUID = (value: string) => {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
};

const cleanId = (value: unknown) => {
  const str = cleanString(value);
  return str && isUUID(str) ? str : undefined;
};

const cleanDate = (value: unknown) => {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const cleanNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
};

const VALID_SPAN_TYPES = ['MIDDLELAYER', 'BACKEND', 'EXTERNAL'] as const;

const cleanSpanType = (value: unknown): 'MIDDLELAYER' | 'BACKEND' | 'EXTERNAL' | undefined => {
  const str = cleanString(value);
  if (str && (VALID_SPAN_TYPES as readonly string[]).includes(str)) {
    return str as 'MIDDLELAYER' | 'BACKEND' | 'EXTERNAL';
  }
  return undefined;
};

// ─── Trace Ensure Helper ────────────────────────────────────────────────────
/**
 * Ensures a trace row exists for the given trackingId BEFORE a span is inserted.
 * Uses a minimal fallback create so we never corrupt the original trace's
 * entryMethod/entryUrl with a child span's data.
 */
const ensureTraceExists = async (
  trackingId: string,
  companyId?: string,
  userId?: string,
) => {
  try {
    await prisma.apiTrace.upsert({
      where: { trackingId },
      create: {
        trackingId,
        entryMethod: 'UNKNOWN',
        entryUrl: 'UNKNOWN',
        startedAt: new Date(),
        ...(companyId && { companyId }),
        ...(userId && { userId }),
      },
      // Only enrich identity — never overwrite entryMethod/entryUrl
      update: {
        ...(companyId && { companyId }),
        ...(userId && { userId }),
      },
    });
  } catch (error: any) {
    if (error.code === 'P2003') {
      // FK constraint on companyId/userId — create without them
      await prisma.apiTrace.upsert({
        where: { trackingId },
        create: {
          trackingId,
          entryMethod: 'UNKNOWN',
          entryUrl: 'UNKNOWN',
          startedAt: new Date(),
        },
        update: {},
      });
    } else if (error.code !== 'P2002') {
      // P2002 = already exists, which is fine. Rethrow anything else.
      throw error;
    }
  }
};

/**
 * TRACKER DB CONTROLLER:
 * Handles incoming trace/span persistence requests from the tracker utility.
 *
 * Flow guarantee: Parent trace is ALWAYS created before child spans.
 * - createTrace is called first (awaited by middleware)
 * - createSpan calls ensureTraceExists as a safety net
 * - updateTrace finalizes the trace with status/latency
 */
export class TrackerDbController {
  /**
   * Creates a new parent trace record.
   * Called by the middleware's startTrace — this MUST succeed before
   * any spans reference this trackingId.
   */
  static async createTrace(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        trackingId,
        companyId,
        userId,
        entryMethod,
        entryUrl,
        startedAt,
      } = req.body;
      const cleanTrackingId = cleanString(trackingId);

      if (!cleanTrackingId) {
        return res.status(400).json({ error: 'trackingId is required' });
      }

      // Look in body first, then headers for identity
      const validCompanyId = cleanId(companyId || req.headers['company-id']);
      const validUserId = cleanId(userId || req.headers['user-id']);

      const cleanEntryMethod = cleanString(entryMethod) || 'UNKNOWN';
      const cleanEntryUrl = cleanString(entryUrl) || 'UNKNOWN';
      const cleanStartedAt = cleanDate(startedAt);

      let trace;
      try {
        trace = await prisma.apiTrace.upsert({
          where: { trackingId: cleanTrackingId },
          create: {
            trackingId: cleanTrackingId,
            ...(validCompanyId && { companyId: validCompanyId }),
            ...(validUserId && { userId: validUserId }),
            entryMethod: cleanEntryMethod,
            entryUrl: cleanEntryUrl,
            startedAt: cleanStartedAt || new Date(),
          },
          update: {
            // Enrich identity if provided, update entry info
            ...(validCompanyId && { companyId: validCompanyId }),
            ...(validUserId && { userId: validUserId }),
            entryMethod: cleanEntryMethod,
            entryUrl: cleanEntryUrl,
          },
        });
      } catch (error: any) {
        if (error.code === 'P2003') {
          // FK constraint — companyId or userId doesn't exist in DB yet.
          // Create trace without FK references.
          trace = await prisma.apiTrace.upsert({
            where: { trackingId: cleanTrackingId },
            create: {
              trackingId: cleanTrackingId,
              entryMethod: cleanEntryMethod,
              entryUrl: cleanEntryUrl,
              startedAt: cleanStartedAt || new Date(),
            },
            update: {
              entryMethod: cleanEntryMethod,
              entryUrl: cleanEntryUrl,
            },
          });
        } else if (error.code === 'P2002') {
          // Race condition — trace was created between our check and insert.
          trace = await prisma.apiTrace.findUnique({
            where: { trackingId: cleanTrackingId },
          });
        } else {
          throw error;
        }
      }

      res.status(201).json(trace);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Finalizes a trace with statusCode, latency, endedAt, and final identity.
   * Called by the middleware's endTrace after the response is sent.
   */
  static async updateTrace(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        trackingId,
        statusCode,
        endedAt,
        totalLatency,
        companyId,
        userId,
      } = req.body;
      const cleanTrackingId = cleanString(trackingId);

      if (!cleanTrackingId) {
        return res.status(400).json({ error: 'trackingId is required' });
      }

      const endedAtDate = cleanDate(endedAt) || new Date();
      const cleanStatusCode = cleanNumber(statusCode);
      const validCompanyId = cleanId(companyId || req.headers['company-id']);
      const validUserId = cleanId(userId || req.headers['user-id']);

      // Calculate latency from trace start if not provided
      const trace = await prisma.apiTrace.findUnique({
        where: { trackingId: cleanTrackingId },
        select: { startedAt: true },
      });

      const resolvedTotalLatency =
        cleanNumber(totalLatency) ??
        (trace?.startedAt
          ? Math.max(0, endedAtDate.getTime() - trace.startedAt.getTime())
          : undefined);

      // Build the update payload — always includes timing data
      const updatePayload: Record<string, any> = {
        statusCode: cleanStatusCode,
        endedAt: endedAtDate,
        totalLatency: resolvedTotalLatency,
      };

      // Add identity fields if valid
      if (validCompanyId) updatePayload.companyId = validCompanyId;
      if (validUserId) updatePayload.userId = validUserId;

      try {
        await prisma.apiTrace.upsert({
          where: { trackingId: cleanTrackingId },
          create: {
            trackingId: cleanTrackingId,
            entryMethod: 'UNKNOWN',
            entryUrl: 'UNKNOWN',
            startedAt: endedAtDate,
            ...updatePayload,
          },
          update: updatePayload,
        });
      } catch (error: any) {
        if (error.code === 'P2003') {
          // FK constraint on identity — still persist timing data
          // Strip only the FK fields that caused the failure
          const safePayload: Record<string, any> = {
            statusCode: cleanStatusCode,
            endedAt: endedAtDate,
            totalLatency: resolvedTotalLatency,
          };

          await prisma.apiTrace.updateMany({
            where: { trackingId: cleanTrackingId },
            data: safePayload,
          });
        }
        // P2002 is harmless (concurrent upsert race) — ignore it
      }

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Creates a child span under an existing trace.
   *
   * Safety: Calls ensureTraceExists first so the FK constraint on trackingId
   * is satisfied even if the parent trace creation was delayed or failed.
   * The ensureTraceExists uses a minimal fallback and NEVER overwrites the
   * original trace's entryMethod/entryUrl.
   */
  static async createSpan(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        id,
        trackingId,
        companyId,
        userId,
        parentSpanId,
        type,
        method,
        url,
        statusCode,
        headers,
        reqBody,
        resBody,
        latency,
        startedAt,
        endedAt,
      } = req.body;

      const cleanTrackingId = cleanString(trackingId);
      if (!cleanTrackingId) {
        return res.status(400).json({ error: 'trackingId is required' });
      }

      // Validate the span type enum
      const cleanType = cleanSpanType(type);
      if (!cleanType) {
        return res.status(400).json({
          error: `Invalid span type: ${type}. Must be one of: ${VALID_SPAN_TYPES.join(', ')}`,
        });
      }

      const validCompanyId = cleanId(companyId || req.headers['company-id']);
      const validUserId = cleanId(userId || req.headers['user-id']);
      const cleanStartedAt = cleanDate(startedAt) || new Date();

      // Step 1: Ensure the parent trace exists (safety net for race conditions).
      // This does NOT overwrite the trace's entryMethod/entryUrl.
      await ensureTraceExists(cleanTrackingId, validCompanyId, validUserId);

      // Step 2: Create the span
      try {
        const span = await prisma.apiSpan.create({
          data: {
            ...(cleanId(id) && { id: cleanId(id) }),
            trackingId: cleanTrackingId,
            ...(validCompanyId && { companyId: validCompanyId }),
            ...(validUserId && { userId: validUserId }),
            parentSpanId: cleanString(parentSpanId),
            type: cleanType,
            method: cleanString(method) || 'UNKNOWN',
            url: cleanString(url) || 'UNKNOWN',
            statusCode: cleanNumber(statusCode),
            headers,
            reqBody,
            resBody,
            latency: cleanNumber(latency),
            startedAt: cleanStartedAt,
            endedAt: cleanDate(endedAt),
          },
        });
        res.status(201).json(span);
      } catch (error: any) {
        if (error.code === 'P2003') {
          // FK constraint on companyId/userId — create span without identity
          const span = await prisma.apiSpan.create({
            data: {
              ...(cleanId(id) && { id: cleanId(id) }),
              trackingId: cleanTrackingId,
              parentSpanId: cleanString(parentSpanId),
              type: cleanType,
              method: cleanString(method) || 'UNKNOWN',
              url: cleanString(url) || 'UNKNOWN',
              statusCode: cleanNumber(statusCode),
              headers,
              reqBody,
              resBody,
              latency: cleanNumber(latency),
              startedAt: cleanStartedAt,
              endedAt: cleanDate(endedAt),
            },
          });
          res.status(201).json(span);
        } else if (error.code === 'P2002') {
          // Duplicate span ID — return existing (idempotent)
          res.status(200).json({ success: true, duplicate: true });
        } else {
          throw error;
        }
      }
    } catch (error) {
      next(error);
    }
  }
}
