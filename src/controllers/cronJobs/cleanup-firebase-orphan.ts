import { Request, Response } from "express";
import { Neo4JConnection } from "../../database/connection";
import { getFirebaseAdminAuth } from "../../graphql/firebase/admin";
import logger from "../../logger";
import { EnvLoader } from "../../util/EnvLoader";

// ---------- helpers ----------
const normalizePath = (p: string) => p.replace(/^\/+/, "").trim();

/**
 * Supports:
 * 1) Firebase download URL:
 *    https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<ENCODED_PATH>?alt=media&token=...
 * 2) GCS URL:
 *    https://storage.googleapis.com/<bucket>/<path>
 * 3) gs:// URL:
 *    gs://<bucket>/<path>
 */
function extractStoragePath(url: string, bucketName?: string): string | null {
  if (!url) return null;

  // (1) firebasestorage.googleapis.com
  // .../o/<encodedPath>?...
  const m1 = url.match(/\/o\/([^?]+)/);
  if (m1?.[1]) {
    try {
      return normalizePath(decodeURIComponent(m1[1]));
    } catch {
      // ignore
    }
  }

  // (2) gs://bucket/path
  const m2 = url.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (m2?.[2]) return normalizePath(m2[2]);

  // (3) https://storage.googleapis.com/bucket/path
  const m3 = url.match(/^https?:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/);
  if (m3?.[2]) return normalizePath(m3[2]);

  // (4) Sometimes people store full firebase URL but bucket known; try to extract "/<bucket>/o/"
  // (already handled by m1)

  // (5) As a last resort: if URL already looks like a path
  if (
    url.startsWith("attachments/") ||
    url.startsWith("/attachments/") ||
    (!url.startsWith("http") && url.includes("/"))
  ) {
    return normalizePath(url);
  }

  return null;
}

const cleanUpFirebaseOrphan = async (req: Request, res: Response) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  const adminApp = getFirebaseAdminAuth();

  try {
    const bucketName = EnvLoader.getOrThrow("FIREBASE_STORAGE_BUCKET"); // e.g. react-flow-f9455.appspot.com

    const prefix = normalizePath((req.query.prefix as string) || "attachments/");
    const dryRun = String(req.query.dryRun ?? "true").toLowerCase() === "true";
    const maxDeletes = Number(req.query.maxDeletes ?? 200);
    const olderThanHours = Number(req.query.olderThanHours ?? 24);

    const cutoffMs = Date.now() - olderThanHours * 60 * 60 * 1000;

    logger.info(
      `Firebase cleanup start bucket=${bucketName} prefix=${prefix} dryRun=${dryRun} maxDeletes=${maxDeletes} olderThanHours=${olderThanHours}`
    );

    // ---- 1) Load DB URLs and build referencedPaths ----
    const referencedPaths = new Set<string>();

    const dbRes = await session.run(`
      MATCH (n:ExternalFile) WHERE NOT EXISTS(()-[:HAS_ATTACHED_FILE]->(n)) RETURN n.url AS url
    `);

    for (const r of dbRes.records) {
      const url = r.get("url") as string | null;
      if (!url) continue;

      const path = extractStoragePath(url, bucketName);
      if (path) referencedPaths.add(path);
    }

    // ---- 2) List storage files & delete if orphan ----
    const bucket = adminApp.storage().bucket(bucketName);

    let processed = 0;
    let deleted = 0;
    let skippedNew = 0;
    let kept = 0;

    const toDelete: string[] = [];
    const keptSample: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    let pageToken: string | undefined = undefined;

    while (true) {
      const [files, nextQuery] = await bucket.getFiles({
        prefix,
        autoPaginate: false,
        maxResults: 500,
        ...(pageToken ? { pageToken } : {}),
      });

      pageToken = (nextQuery as any)?.pageToken as string | undefined;

      for (const file of files) {
        processed++;

        const objectPath = normalizePath(file.name);
        if (!objectPath) continue;

        // If referenced, keep it
        if (referencedPaths.has(objectPath)) {
          kept++;
          if (keptSample.length < 15) keptSample.push(objectPath);
          continue;
        }

        // Safety: only delete old objects
        const [meta] = await file.getMetadata().catch(() => [null as any]);
        const updatedMs = meta?.updated ? new Date(meta.updated).getTime() : 0;

        if (updatedMs && updatedMs > cutoffMs) {
          skippedNew++;
          continue;
        }

        // Candidate orphan
        if (dryRun) {
          toDelete.push(objectPath);
          deleted++;
        } else {
          try {
            await file.delete(); // IMPORTANT: no ignoreNotFound while debugging
            const [exists] = await file.exists();
            if (exists) {
              failed.push({ path: objectPath, error: "Delete called but file still exists" });
            } else {
              deleted++;
            }
          } catch (e: any) {
            failed.push({ path: objectPath, error: e?.message || String(e) });
          }
        }

        if (deleted >= maxDeletes) break;
      }

      if (deleted >= maxDeletes) break;
      if (!pageToken) break;
    }

    return res.status(200).json({
      ok: true,
      bucket: bucketName,
      prefix,
      dryRun,
      olderThanHours,
      maxDeletes,
      cutoffIso: new Date(cutoffMs).toISOString(),
      dbReferencedCount: referencedPaths.size,
      processed,
      kept,
      skippedNew,
      deleted,
      ...(dryRun ? { toDelete } : {}),
      failed,
      keptSample,
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      message: "Failed to clean up the firebase orphan data.",
      error: error?.message || String(error),
    });
  } finally {
    await session.close();
  }
};

export default cleanUpFirebaseOrphan;
