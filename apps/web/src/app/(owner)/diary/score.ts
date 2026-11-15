// Scores a diary entry now with the configured model ("off" where routing is not configured: preview and local).
// Never throws: a failure is a code, so a saved entry is never lost. No auth here; each calling action checks the owner.
import { dbErrorLabel } from "@/server/db";
import { scoreDiaryEntry } from "@/server/mood";
import { routerDb, routerFromEnv } from "@/server/router";
import type { ScoreResult } from "./notices";

export async function scoreNow(diaryEntryId: string): Promise<ScoreResult> {
  try {
    const provider = await routerFromEnv(process.env);
    if (!provider) return "off";
    return await scoreDiaryEntry(routerDb, diaryEntryId, provider);
  } catch (err) {
    console.error(`[mood] ${dbErrorLabel(err)}`);
    return "failed";
  }
}
