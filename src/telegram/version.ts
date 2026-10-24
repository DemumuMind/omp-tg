import { version as currentVersion } from "../../package.json";

const RELEASE_REPO = "DemumuMind/omp-tg";

export function gatewayVersion(): string {
  return currentVersion;
}

export interface VersionReport {
  current: string;
  latest: string | null;
  upToDate: boolean | null;
}

/** Compares the baked-in version against the newest GitHub release tag. */
export async function checkForUpdate(timeoutMs = 4000): Promise<VersionReport> {
  let latest: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { "User-Agent": "omp-tg" },
    });
    clearTimeout(timer);
    if (response.ok) {
      const payload = (await response.json()) as { tag_name?: string };
      latest = payload.tag_name ?? null;
    }
  } catch {
    // Offline or rate-limited: report current version only.
  }
  const upToDate = latest === null ? null : latest === `v${currentVersion}`;
  return { current: currentVersion, latest, upToDate };
}

export function formatVersionReport(report: VersionReport): string {
  const lines = [`<b>omp-tg</b> <code>v${report.current}</code>`];
  if (report.latest === null) {
    lines.push("Не удалось проверить обновление");
  } else if (report.upToDate) {
    lines.push(`Актуальная версия (${report.latest})`);
  } else {
    lines.push(`Доступна ${report.latest} — обновить: <code>sudo sh deploy/omp-tg-update.sh</code>`);
  }
  return lines.join("\n");
}
