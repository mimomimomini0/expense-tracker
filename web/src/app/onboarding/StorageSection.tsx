import { getTranslations } from "next-intl/server";
import { getStorageInfo, reconcile, type ReconcileResult } from "@/lib/storage-data";

/** #3 + #4: locate the local PDF (fixtures) folder and reconcile it against
 *  the imported statements. Local-mode only — hidden meaning is shown when the
 *  folder isn't present (e.g. cloud deployment). */
export default async function StorageSection({ runReconcile }: { runReconcile: boolean }) {
  const t = await getTranslations("storage");
  const info = getStorageInfo();

  let result: ReconcileResult | null = null;
  if (runReconcile && info.exists) result = await reconcile();

  return (
    <section className="panel">
      <h2>{t("title")}</h2>
      <p className="inline-note">{t("note")}</p>

      <div className="storage-path">
        <span className="storage-label">{t("folder")}</span>
        <code className="storage-code">{info.dir}</code>
      </div>
      {info.exists ? (
        <p className="muted">{t("found", { count: info.fileCount })}</p>
      ) : (
        <p className="notice">{t("notFound")}</p>
      )}

      {info.exists && (
        <p style={{ marginTop: "0.6rem" }}>
          <a className="btn" href="/onboarding?reconcile=1#storage">{t("runReconcile")}</a>
        </p>
      )}

      {result && (
        <div className="reconcile-result" id="storage">
          <p className="muted">{t("matched", { count: result.matched })}</p>

          <h3>{t("newTitle", { count: result.newOnDisk.length })}</h3>
          {result.newOnDisk.length === 0 ? (
            <p className="muted">{t("noneNew")}</p>
          ) : (
            <>
              <ul className="reconcile-list">
                {result.newOnDisk.map((f) => (
                  <li key={f.hash}><span className="desc-raw">{f.name}</span></li>
                ))}
              </ul>
              <p className="inline-note">{t("newHint")}</p>
            </>
          )}

          <h3>{t("missingTitle", { count: result.missingOnDisk.length })}</h3>
          {result.missingOnDisk.length === 0 ? (
            <p className="muted">{t("noneMissing")}</p>
          ) : (
            <>
              <ul className="reconcile-list">
                {result.missingOnDisk.map((f) => (
                  <li key={f.hash}><span className="desc-raw">{f.filename}</span></li>
                ))}
              </ul>
              <p className="inline-note">{t("missingHint")}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
