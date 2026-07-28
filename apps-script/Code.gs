/**
 * @OnlyCurrentDoc
 *
 * VeilleData Collector
 * ====================
 *
 * This script:
 *
 * 1. Reads the active sources listed in the "sources" tab.
 * 2. Checks that each URL is explicitly authorised.
 * 3. Downloads the corresponding public Atom feeds.
 * 4. Verifies that the responses are valid Atom XML documents.
 * 5. Normalises the publications.
 * 6. Prevents duplicate insertions.
 * 7. Writes all new publications to "items" in a single batch.
 * 8. Records every execution in "run_log".
 *
 * Security principles:
 *
 * - Least privilege with @OnlyCurrentDoc.
 * - Exact URL allowlist.
 * - HTTPS required.
 * - Redirects disabled.
 * - HTTPS certificate validation enabled.
 * - Response size and item count limited.
 * - XML structure validated before use.
 * - External text sanitised before writing to Sheets.
 * - Concurrent executions prevented with LockService.
 * - No password, API key or secret stored in the code.
 */


/**
 * Central configuration.
 *
 * Keeping the values together makes the script easier to audit
 * and prevents important security rules from being scattered
 * throughout the code.
 */
const CONFIG = {
  /**
   * Names of the three required Google Sheets tabs.
   */
  SOURCES_SHEET: "sources",
  ITEMS_SHEET: "items",
  LOG_SHEET: "run_log",

  /**
   * Operational limits.
   *
   * These limits reduce the risk created by:
   *
   * - an unexpectedly large feed;
   * - an accidental configuration error;
   * - an excessive number of active sources;
   * - uncontrolled writes to the spreadsheet.
   */
  MAX_ACTIVE_SOURCES: 10,
  MAX_ITEMS_PER_SOURCE: 20,
  MAX_TOTAL_ITEMS_PER_RUN: 100,
  MAX_RESPONSE_CHARS: 1000000,

  /**
   * Maximum lengths for external text.
   *
   * Text retrieved from an external source is always treated
   * as untrusted input, even when the source is GitHub.
   */
  MAX_TITLE_LENGTH: 250,
  MAX_SUMMARY_LENGTH: 500,
  MAX_URL_LENGTH: 1000,
  MAX_LOG_MESSAGE_LENGTH: 1000,

  /**
   * Exact list of authorised feeds.
   *
   * A URL entered in the "sources" tab must match one of these
   * values exactly.
   *
   * This prevents somebody with edit access to the spreadsheet
   * from making the script contact an arbitrary external server.
   */
  ALLOWED_FEED_URLS: new Set([
    "https://github.com/unionai-oss/pandera/releases.atom",
    "https://github.com/fivetran/great_expectations/releases.atom",
    "https://github.com/scikit-learn/scikit-learn/releases.atom"
  ]),

  /**
   * Expected headers for the "sources" tab.
   */
  SOURCES_HEADERS: [
    "source_id",
    "source_name",
    "feed_url",
    "source_type",
    "theme_hint",
    "active"
  ],

  /**
   * Expected headers for the "items" tab.
   *
   * Columns A to I are populated automatically.
   * Columns J to M are reserved for human interpretation.
   */
  ITEMS_HEADERS: [
    "item_id",
    "fetched_at",
    "published_at",
    "source_name",
    "source_type",
    "title",
    "url",
    "summary",
    "theme",
    "status",
    "relevance",
    "project_impact",
    "reviewed"
  ],

  /**
   * Expected headers for the "run_log" tab.
   */
  LOG_HEADERS: [
    "run_at",
    "status",
    "sources_checked",
    "items_found",
    "items_added",
    "message"
  ]
};


/**
 * Main collection function.
 *
 * Select runWatch in the function selector and click Run.
 */
function runWatch() {
  /**
   * A document lock prevents two executions from writing to
   * the same spreadsheet simultaneously.
   *
   * This may happen if a manual execution overlaps with a
   * scheduled trigger.
   */
  const lock =
    LockService.getDocumentLock() ||
    LockService.getScriptLock();

  /**
   * tryLock is preferable here to waiting indefinitely.
   *
   * If another execution still owns the lock after 30 seconds,
   * this execution stops cleanly.
   */
  if (!lock.tryLock(30000)) {
    throw new Error(
      "Une autre collecte est déjà en cours. Réessayez dans quelques instants."
    );
  }

  const startedAt = new Date();

  let spreadsheet = null;
  let logSheet = null;
  let logWritten = false;

  let sourcesChecked = 0;
  let itemsFound = 0;
  let itemsAdded = 0;

  try {
    /**
     * Because this is a script bound to the Google Sheet,
     * getActiveSpreadsheet returns the current document.
     */
    spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

    if (!spreadsheet) {
      throw new Error(
        "Aucune feuille Google active n'a été trouvée."
      );
    }

    /**
     * Retrieve the three required tabs.
     *
     * The function throws a clear error if one is missing.
     */
    const sourcesSheet = getRequiredSheet_(
      spreadsheet,
      CONFIG.SOURCES_SHEET
    );

    const itemsSheet = getRequiredSheet_(
      spreadsheet,
      CONFIG.ITEMS_SHEET
    );

    logSheet = getRequiredSheet_(
      spreadsheet,
      CONFIG.LOG_SHEET
    );

    /**
     * Verify that the spreadsheet structure has not been changed.
     *
     * This prevents data from being written into the wrong columns.
     */
    validateHeaders_(
      sourcesSheet,
      CONFIG.SOURCES_HEADERS
    );

    validateHeaders_(
      itemsSheet,
      CONFIG.ITEMS_HEADERS
    );

    validateHeaders_(
      logSheet,
      CONFIG.LOG_HEADERS
    );

    /**
     * Read and validate the active sources.
     */
    const sources = readActiveSources_(sourcesSheet);

    if (sources.length === 0) {
      throw new Error(
        "Aucune source active n'a été trouvée dans l'onglet sources."
      );
    }

    if (sources.length > CONFIG.MAX_ACTIVE_SOURCES) {
      throw new Error(
        "Trop de sources actives. Maximum autorisé : " +
        CONFIG.MAX_ACTIVE_SOURCES +
        "."
      );
    }

    /**
     * Load all identifiers already present in the items tab.
     *
     * A Set provides fast duplicate checks.
     */
    const existingIds = readExistingItemIds_(itemsSheet);

    /**
     * rowsToWrite contains all new rows that will later be
     * inserted in a single setValues operation.
     */
    const rowsToWrite = [];

    /**
     * A failure affecting one source does not necessarily stop
     * the other sources.
     */
    const sourceErrors = [];

    sources.forEach(function(source) {
      sourcesChecked += 1;

      try {
        /**
         * Download the feed after validating its URL.
         */
        const xml = fetchFeed_(source.feedUrl);

        const entries = parseAtomFeed_(
          xml,
          source
        );

        if (entries.length === 0) {
          throw new Error(
            "Flux Atom reçu, mais aucune entrée exploitable n'a été conservée."
          );
        }

itemsFound += entries.length;

        entries.forEach(function(item) {
          /**
           * The Set prevents:
           *
           * - duplicates already stored in the sheet;
           * - duplicates appearing twice during the same run.
           */
          if (!existingIds.has(item.itemId)) {
            rowsToWrite.push(item.row);
            existingIds.add(item.itemId);
          }
        });

      } catch (error) {
        /**
         * Do not write the complete stack trace into the Sheet.
         *
         * A concise message is sufficient for operational logging.
         */
        sourceErrors.push(
          source.sourceName +
          " : " +
          sanitiseLogMessage_(error.message)
        );
      }
    });

    /**
     * Global limit for one execution.
     *
     * This check takes place before any new rows are written.
     */
    if (
      rowsToWrite.length >
      CONFIG.MAX_TOTAL_ITEMS_PER_RUN
    ) {
      throw new Error(
        "Collecte interrompue : " +
        rowsToWrite.length +
        " nouveaux éléments ont été préparés, alors que la limite est de " +
        CONFIG.MAX_TOTAL_ITEMS_PER_RUN +
        "."
      );
    }

    /**
     * Batch write.
     *
     * One setValues call is faster and more reliable than writing
     * one cell or one row at a time.
     */
    if (rowsToWrite.length > 0) {
      writeItemsInBatch_(
        itemsSheet,
        rowsToWrite
      );
    }

    itemsAdded = rowsToWrite.length;

    /**
     * Determine the overall execution status.
     */
    let status = "SUCCESS";

    if (sourceErrors.length > 0) {
      status =
        sourceErrors.length === sources.length
          ? "ERROR"
          : "PARTIAL";
    }

    const message =
      sourceErrors.length > 0
        ? sourceErrors.join(" | ")
        : "Collecte terminée sans erreur.";

    /**
     * Write one execution record.
     */
    writeRunLog_(
      logSheet,
      startedAt,
      status,
      sourcesChecked,
      itemsFound,
      itemsAdded,
      message
    );

    logWritten = true;

    /**
     * Ensure pending spreadsheet updates are applied before
     * displaying the success message.
     */
    SpreadsheetApp.flush();

    spreadsheet.toast(
      itemsAdded +
      " nouvel élément ajouté. Statut : " +
      status +
      ".",
      "VeilleData",
      8
    );

    /**
     * When every source failed, the execution should also appear
     * as failed in the Apps Script execution history.
     */
    if (status === "ERROR") {
      throw new Error(
        "Toutes les sources ont échoué. Consultez l'onglet run_log."
      );
    }

  } catch (error) {
    /**
     * Write an error log unless the execution has already been
     * recorded.
     */
    if (logSheet !== null && !logWritten) {
      writeRunLog_(
        logSheet,
        startedAt,
        "ERROR",
        sourcesChecked,
        itemsFound,
        itemsAdded,
        sanitiseLogMessage_(error.message)
      );
    }

    /**
     * Re-throw the error so that Apps Script marks the execution
     * as failed.
     */
    throw error;

  } finally {
    /**
     * Always release the lock, including after an error.
     */
    lock.releaseLock();
  }
}


/**
 * Retrieves a required tab by name.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
 * @param {string} sheetName
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getRequiredSheet_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error(
      'L\'onglet "' +
      sheetName +
      '" est introuvable.'
    );
  }

  return sheet;
}


/**
 * Checks that the first row contains exactly the expected headers.
 *
 * This prevents accidental column shifts and protects the integrity
 * of batch writes.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string[]} expectedHeaders
 */
function validateHeaders_(sheet, expectedHeaders) {
  const actualHeaders = sheet
    .getRange(
      1,
      1,
      1,
      expectedHeaders.length
    )
    .getDisplayValues()[0]
    .map(function(value) {
      return String(value).trim();
    });

  expectedHeaders.forEach(function(expected, index) {
    if (actualHeaders[index] !== expected) {
      throw new Error(
        'En-tête incorrect dans l\'onglet "' +
        sheet.getName() +
        '", cellule ' +
        columnNumberToLetter_(index + 1) +
        '1. Attendu : "' +
        expected +
        '", trouvé : "' +
        actualHeaders[index] +
        '".'
      );
    }
  });
}


/**
 * Reads and validates active source rows.
 *
 * Security checks performed here:
 *
 * - maximum source count;
 * - required fields;
 * - source_id format;
 * - duplicate source identifiers;
 * - HTTPS requirement;
 * - exact URL allowlist;
 * - URL length limit.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Object[]}
 */
function readActiveSources_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const rows = sheet
    .getRange(
      2,
      1,
      lastRow - 1,
      CONFIG.SOURCES_HEADERS.length
    )
    .getValues();

  const activeSources = [];
  const sourceIds = new Set();

  rows.forEach(function(row, index) {
    const sheetRow = index + 2;

    /**
     * Ignore inactive rows.
     */
    if (!isTrue_(row[5])) {
      return;
    }

    const source = {
      sourceId: String(row[0] || "").trim(),
      sourceName: String(row[1] || "").trim(),
      feedUrl: String(row[2] || "").trim(),
      sourceType: String(row[3] || "").trim(),
      themeHint: String(row[4] || "").trim()
    };

    /**
     * Required fields.
     */
    if (
      !source.sourceId ||
      !source.sourceName ||
      !source.feedUrl
    ) {
      throw new Error(
        "Source incomplète à la ligne " +
        sheetRow +
        "."
      );
    }

    /**
     * Restrict source identifiers to a predictable format.
     */
    if (!/^[a-z0-9_-]{2,50}$/.test(source.sourceId)) {
      throw new Error(
        "source_id invalide à la ligne " +
        sheetRow +
        ". Utilisez uniquement des lettres minuscules, chiffres, tirets et underscores."
      );
    }

    /**
     * Reject duplicated source identifiers.
     */
    if (sourceIds.has(source.sourceId)) {
      throw new Error(
        'source_id dupliqué : "' +
        source.sourceId +
        '".'
      );
    }

    sourceIds.add(source.sourceId);

    /**
     * URL length control.
     */
    if (
      source.feedUrl.length >
      CONFIG.MAX_URL_LENGTH
    ) {
      throw new Error(
        "URL trop longue à la ligne " +
        sheetRow +
        "."
      );
    }

    /**
     * Require HTTPS.
     */
    if (!source.feedUrl.startsWith("https://")) {
      throw new Error(
        "Source refusée à la ligne " +
        sheetRow +
        " : HTTPS est obligatoire."
      );
    }

    /**
     * Exact code-level allowlist.
     */
    if (
      !CONFIG.ALLOWED_FEED_URLS.has(
        source.feedUrl
      )
    ) {
      throw new Error(
        "Source refusée à la ligne " +
        sheetRow +
        " : l'URL ne figure pas dans la liste autorisée."
      );
    }

    activeSources.push(source);
  });

  return activeSources;
}


/**
 * Télécharge un flux Atom approuvé.
 *
 * La fonction accepte au maximum une redirection HTTP.
 * La redirection doit :
 *
 * - utiliser HTTPS ;
 * - rester sur github.com ;
 * - rester dans le même dépôt approuvé ;
 * - mener à un fichier releases.atom.
 */
function fetchFeed_(feedUrl) {
  if (!CONFIG.ALLOWED_FEED_URLS.has(feedUrl)) {
    throw new Error(
      "Source refusée : URL initiale non autorisée."
    );
  }

  let response = fetchOnce_(feedUrl);
  let responseCode = response.getResponseCode();

  /**
   * GitHub peut renvoyer une redirection permanente ou temporaire.
   *
   * Nous ne suivons pas la redirection aveuglément :
   * nous lisons d'abord l'en-tête Location et nous validons
   * explicitement la destination.
   */
  if (isRedirectStatus_(responseCode)) {
    const headers = response.getAllHeaders();

    const location = String(
      headers["Location"] ||
      headers["location"] ||
      ""
    ).trim();

    if (!location) {
      throw new Error(
        "Redirection HTTP sans en-tête Location."
      );
    }

    const redirectUrl = resolveRedirectUrl_(
      feedUrl,
      location
    );

    if (
      !isSafeRepositoryRedirect_(
        feedUrl,
        redirectUrl
      )
    ) {
      throw new Error(
        "Redirection refusée vers : " +
        redirectUrl
      );
    }

    /**
     * Une seule redirection est autorisée.
     */
    response = fetchOnce_(redirectUrl);
    responseCode = response.getResponseCode();

    if (isRedirectStatus_(responseCode)) {
      throw new Error(
        "Deuxième redirection refusée."
      );
    }
  }

  if (responseCode !== 200) {
    throw new Error(
      "Réponse HTTP inattendue : " +
      responseCode +
      "."
    );
  }

  const headers = response.getAllHeaders();

  const contentType = String(
    headers["Content-Type"] ||
    headers["content-type"] ||
    ""
  ).toLowerCase();

  if (
    !contentType.includes("xml") &&
    !contentType.includes("atom")
  ) {
    throw new Error(
      "Type de contenu inattendu : " +
      (contentType || "non fourni") +
      "."
    );
  }

  const content = response.getContentText(
    "UTF-8"
  );

  if (!content.trim()) {
    throw new Error(
      "Flux refusé : réponse vide."
    );
  }

  if (
    content.length >
    CONFIG.MAX_RESPONSE_CHARS
  ) {
    throw new Error(
      "Flux refusé : réponse anormalement volumineuse."
    );
  }

  return content;
}


/**
 * Effectue une requête HTTP unique sans suivre les redirections.
 */
function fetchOnce_(url) {
  return UrlFetchApp.fetch(url, {
    method: "get",
    followRedirects: false,
    muteHttpExceptions: true,
    validateHttpsCertificates: true,

    headers: {
      "User-Agent": "VeilleData-Tableau/1.0",
      "Accept":
        "application/atom+xml, application/xml, text/xml"
    }
  });
}


/**
 * Indique si le code HTTP correspond à une redirection.
 */
function isRedirectStatus_(statusCode) {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}


/**
 * Transforme une destination relative en URL absolue.
 */
function resolveRedirectUrl_(
  originalUrl,
  location
) {
  try {
    return new URL(
      location,
      originalUrl
    ).toString();
  } catch (error) {
    throw new Error(
      "URL de redirection invalide : " +
      location
    );
  }
}


/**
 * Vérifie que la redirection reste dans le même dépôt GitHub.
 */
function isSafeRepositoryRedirect_(
  originalUrl,
  redirectUrl
) {
  try {
    const original = new URL(originalUrl);
    const redirected = new URL(redirectUrl);

    if (redirected.protocol !== "https:") {
      return false;
    }

    if (
      redirected.hostname.toLowerCase() !==
      "github.com"
    ) {
      return false;
    }

    /**
     * Extrait le chemin du dépôt :
     *
     * /organisation/depot/releases.atom
     * devient
     * /organisation/depot/
     */
    const originalRepositoryPath =
      original.pathname.replace(
        /releases\.atom$/,
        ""
      );

    if (
      !redirected.pathname.startsWith(
        originalRepositoryPath
      )
    ) {
      return false;
    }

    return (
      redirected.pathname.endsWith(
        "/releases.atom"
      ) ||
      redirected.pathname.endsWith(
        "releases.atom"
      )
    );

  } catch (error) {
    return false;
  }
}


/**
 * Parses and normalises a GitHub Atom feed.
 *
 * @param {string} xml
 * @param {Object} source
 * @return {Object[]}
 */
function parseAtomFeed_(xml, source) {
  let document;

  try {
    document = XmlService.parse(xml);
  } catch (error) {
    throw new Error(
      "XML invalide ou impossible à analyser."
    );
  }

  const root = document.getRootElement();

  /**
   * A valid Atom document must use <feed> as its root element.
   */
  if (
    root.getName().toLowerCase() !== "feed"
  ) {
    throw new Error(
      'Document refusé : l\'élément racine n\'est pas "feed".'
    );
  }

  const atomNamespace = root.getNamespace();
  const namespaceUri = atomNamespace.getURI();

  /**
   * Validate the standard Atom namespace.
   */
  if (
    namespaceUri !==
    "http://www.w3.org/2005/Atom"
  ) {
    throw new Error(
      "Document refusé : espace de noms Atom inattendu."
    );
  }

  /**
   * Limit the number of entries processed per source.
   */
  const entries = root
    .getChildren("entry", atomNamespace)
    .slice(
      0,
      CONFIG.MAX_ITEMS_PER_SOURCE
    );

  return entries
    .map(function(entry) {
      return normaliseAtomEntry_(
        entry,
        atomNamespace,
        source
      );
    })
    .filter(function(item) {
      /**
       * Invalid or unusable entries return null and are ignored.
       */
      return item !== null;
    });
}


/**
 * Converts one Atom entry into the structure expected by "items".
 *
 * @param {GoogleAppsScript.XML_Service.Element} entry
 * @param {GoogleAppsScript.XML_Service.Namespace} atomNamespace
 * @param {Object} source
 * @return {Object|null}
 */
function normaliseAtomEntry_(
  entry,
  atomNamespace,
  source
) {
  const entryId = getChildText_(
    entry,
    "id",
    atomNamespace
  );

  const title = cleanExternalText_(
    getChildText_(
      entry,
      "title",
      atomNamespace
    ),
    CONFIG.MAX_TITLE_LENGTH
  );

  const publishedText =
    getChildText_(
      entry,
      "published",
      atomNamespace
    ) ||
    getChildText_(
      entry,
      "updated",
      atomNamespace
    );

  const publishedAt =
    parseAtomDate_(publishedText);

  const url = cleanAndValidateItemUrl_(
    getEntryUrl_(
      entry,
      atomNamespace
    ),
    source.feedUrl
  );

  const rawSummary =
    getChildText_(
      entry,
      "summary",
      atomNamespace
    ) ||
    getChildText_(
      entry,
      "content",
      atomNamespace
    );

  const summary = cleanExternalText_(
    rawSummary,
    CONFIG.MAX_SUMMARY_LENGTH
  );

  /**
   * An entry without both a title and a URL is not useful for
   * the watch dashboard.
   */
  if (!title || !url) {
    return null;
  }

  /**
   * Build a stable source string for deduplication.
   *
   * The original Atom ID is preferred. The URL is the fallback.
   */
  const stableValue =
    entryId ||
    url ||
    [
      source.sourceId,
      title,
      publishedText
    ].join("|");

  /**
   * Hash the external identifier.
   *
   * The resulting item_id is short, predictable and contains no
   * untrusted external markup.
   */
  const itemId =
    source.sourceId +
    "_" +
    sha256Hex_(stableValue);

  return {
    itemId: itemId,

    row: [
      itemId,
      new Date(),
      publishedAt,
      safeSheetText_(
        source.sourceName,
        150
      ),
      safeSheetText_(
        source.sourceType,
        100
      ),
      safeSheetText_(
        title,
        CONFIG.MAX_TITLE_LENGTH
      ),
      safeSheetText_(
        url,
        CONFIG.MAX_URL_LENGTH
      ),
      safeSheetText_(
        summary,
        CONFIG.MAX_SUMMARY_LENGTH
      ),
      safeSheetText_(
        source.themeHint,
        100
      ),

      /**
       * Human-controlled columns.
       */
      "",
      "",
      "",
      false
    ]
  };
}


/**
 * Retrieves the main URL from an Atom entry.
 *
 * The function prefers a link whose rel attribute is "alternate".
 *
 * @param {GoogleAppsScript.XML_Service.Element} entry
 * @param {GoogleAppsScript.XML_Service.Namespace} namespace
 * @return {string}
 */
function getEntryUrl_(entry, namespace) {
  const links = entry.getChildren(
    "link",
    namespace
  );

  let fallbackUrl = "";

  for (let i = 0; i < links.length; i += 1) {
    const hrefAttribute =
      links[i].getAttribute("href");

    if (!hrefAttribute) {
      continue;
    }

    const href =
      hrefAttribute.getValue().trim();

    if (!fallbackUrl) {
      fallbackUrl = href;
    }

    const relAttribute =
      links[i].getAttribute("rel");

    const rel = relAttribute
      ? relAttribute.getValue()
      : "alternate";

    if (rel === "alternate") {
      return href;
    }
  }

  return fallbackUrl;
}


/**
 * Vérifie qu'une URL de publication :
 *
 * - utilise HTTPS ;
 * - pointe vers github.com ;
 * - appartient au même dépôt que le flux autorisé ;
 * - ne contient ni espace ni caractère de contrôle.
 *
 * Cette version évite le constructeur new URL(),
 * qui échoue dans l'environnement Apps Script utilisé ici.
 *
 * @param {string} value URL récupérée dans l'entrée Atom.
 * @param {string} feedUrl URL du flux releases.atom.
 * @return {string} URL validée ou chaîne vide.
 */
function cleanAndValidateItemUrl_(
  value,
  feedUrl
) {
  const text = String(value || "").trim();

  if (!text) {
    return "";
  }

  if (
    text.length >
    CONFIG.MAX_URL_LENGTH
  ) {
    return "";
  }

  /**
   * Refuse les espaces et caractères de contrôle.
   */
  if (
    /[\u0000-\u001F\u007F\s]/.test(text)
  ) {
    return "";
  }

  /**
   * L'hôte doit être exactement github.com.
   *
   * Cette expression refuse notamment :
   *
   * https://github.com.example.com/
   * http://github.com/
   */
  if (
    !/^https:\/\/github\.com\//i.test(text)
  ) {
    return "";
  }

  /**
   * Construit le préfixe du dépôt à partir du flux :
   *
   * https://github.com/org/repo/releases.atom
   *
   * devient :
   *
   * https://github.com/org/repo/
   */
  const repositoryPrefix = String(
    feedUrl || ""
  )
    .replace(
      /\/releases\.atom$/i,
      "/"
    )
    .toLowerCase();

  if (!repositoryPrefix) {
    return "";
  }

  /**
   * L'URL de publication doit rester dans le même dépôt.
   */
  if (
    text.toLowerCase().indexOf(
      repositoryPrefix
    ) !== 0
  ) {
    return "";
  }

  return text;
}


/**
 * Returns the text of one XML child element.
 *
 * @param {GoogleAppsScript.XML_Service.Element} element
 * @param {string} childName
 * @param {GoogleAppsScript.XML_Service.Namespace} namespace
 * @return {string}
 */
function getChildText_(
  element,
  childName,
  namespace
) {
  const child = element.getChild(
    childName,
    namespace
  );

  return child
    ? child.getText()
    : "";
}


/**
 * Cleans untrusted text retrieved from an external feed.
 *
 * Operations:
 *
 * - removes HTML tags;
 * - replaces common HTML spaces;
 * - removes ASCII control characters;
 * - normalises whitespace;
 * - limits the final length.
 *
 * @param {*} value
 * @param {number} maxLength
 * @return {string}
 */
function cleanExternalText_(
  value,
  maxLength
) {
  let text = String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(
      /[\u0000-\u001F\u007F]/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > maxLength) {
    text =
      text.substring(
        0,
        maxLength - 1
      ) +
      "…";
  }

  return text;
}


/**
 * Converts an Atom date to a native Date object.
 *
 * Invalid dates return an empty value rather than causing
 * the entire collection to fail.
 *
 * @param {string} value
 * @return {Date|string}
 */
function parseAtomDate_(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  return isNaN(date.getTime())
    ? ""
    : date;
}


/**
 * Generates a hexadecimal SHA-256 digest.
 *
 * Hashing creates a compact stable identifier without storing
 * the raw external entry ID in the item_id column.
 *
 * @param {*} value
 * @return {string}
 */
function sha256Hex_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );

  return bytes
    .map(function(byte) {
      /**
       * Java bytes may be signed, so convert them to 0–255.
       */
      const unsignedByte =
        byte < 0
          ? byte + 256
          : byte;

      return (
        "0" +
        unsignedByte.toString(16)
      ).slice(-2);
    })
    .join("");
}


/**
 * Reads all item identifiers already stored in the sheet.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Set<string>}
 */
function readExistingItemIds_(sheet) {
  const existingIds = new Set();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return existingIds;
  }

  const values = sheet
    .getRange(
      2,
      1,
      lastRow - 1,
      1
    )
    .getDisplayValues();

  values.forEach(function(row) {
    const itemId =
      String(row[0] || "").trim();

    if (itemId) {
      existingIds.add(itemId);
    }
  });

  return existingIds;
}


/**
 * Writes all new items in one batch.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array[]} rows
 */
function writeItemsInBatch_(sheet, rows) {
  if (!rows || rows.length === 0) {
    return;
  }

  if (
    rows.length >
    CONFIG.MAX_TOTAL_ITEMS_PER_RUN
  ) {
    throw new Error(
      "Limite d'écriture dépassée."
    );
  }

  /**
   * Validate the row width before setValues.
   */
  rows.forEach(function(row, index) {
    if (
      row.length !==
      CONFIG.ITEMS_HEADERS.length
    ) {
      throw new Error(
        "Ligne normalisée invalide à l'index " +
        index +
        "."
      );
    }
  });

  const firstRow =
    sheet.getLastRow() + 1;

  sheet
    .getRange(
      firstRow,
      1,
      rows.length,
      CONFIG.ITEMS_HEADERS.length
    )
    .setValues(rows);

  /**
   * Format fetched_at and published_at.
   */
  sheet
    .getRange(
      firstRow,
      2,
      rows.length,
      2
    )
    .setNumberFormat(
      "yyyy-mm-dd hh:mm:ss"
    );
}


/**
 * Writes one execution record to run_log.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Date} runAt
 * @param {string} status
 * @param {number} sourcesChecked
 * @param {number} itemsFound
 * @param {number} itemsAdded
 * @param {string} message
 */
function writeRunLog_(
  sheet,
  runAt,
  status,
  sourcesChecked,
  itemsFound,
  itemsAdded,
  message
) {
  const allowedStatuses = new Set([
    "SUCCESS",
    "PARTIAL",
    "ERROR"
  ]);

  const safeStatus =
    allowedStatuses.has(status)
      ? status
      : "ERROR";

  const row = [[
    runAt,
    safeStatus,
    normaliseCount_(sourcesChecked),
    normaliseCount_(itemsFound),
    normaliseCount_(itemsAdded),
    safeSheetText_(
      message,
      CONFIG.MAX_LOG_MESSAGE_LENGTH
    )
  ]];

  const firstRow =
    sheet.getLastRow() + 1;

  sheet
    .getRange(
      firstRow,
      1,
      1,
      CONFIG.LOG_HEADERS.length
    )
    .setValues(row);

  sheet
    .getRange(
      firstRow,
      1
    )
    .setNumberFormat(
      "yyyy-mm-dd hh:mm:ss"
    );
}


/**
 * Prevents external text from being interpreted as a spreadsheet
 * formula.
 *
 * Google Sheets can interpret cells beginning with:
 *
 * =  +  -  @
 *
 * as formulas. Prefixing the value with an apostrophe forces it
 * to remain plain text.
 *
 * @param {*} value
 * @param {number} maxLength
 * @return {string}
 */
function safeSheetText_(
  value,
  maxLength
) {
  let text = String(value || "")
    .replace(
      /[\u0000-\u001F\u007F]/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  const limit =
    Number.isInteger(maxLength) &&
    maxLength > 0
      ? maxLength
      : 1000;

  if (text.length > limit) {
    text =
      text.substring(
        0,
        limit - 1
      ) +
      "…";
  }

  /**
   * Formula-injection protection.
   */
  if (/^[=+\-@]/.test(text)) {
    text = "'" + text;
  }

  return text;
}


/**
 * Sanitises an error message before it is stored in run_log.
 *
 * @param {*} value
 * @return {string}
 */
function sanitiseLogMessage_(value) {
  return safeSheetText_(
    value,
    CONFIG.MAX_LOG_MESSAGE_LENGTH
  );
}


/**
 * Converts counters to safe non-negative integers.
 *
 * @param {*} value
 * @return {number}
 */
function normaliseCount_(value) {
  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    return 0;
  }

  return Math.floor(number);
}


/**
 * Interprets a checkbox or textual TRUE value.
 *
 * @param {*} value
 * @return {boolean}
 */
function isTrue_(value) {
  return (
    value === true ||
    String(value)
      .toLowerCase()
      .trim() === "true"
  );
}


/**
 * Converts a column number to its spreadsheet letter.
 *
 * Examples:
 *
 * 1 -> A
 * 2 -> B
 * 27 -> AA
 *
 * @param {number} columnNumber
 * @return {string}
 */
function columnNumberToLetter_(
  columnNumber
) {
  let result = "";
  let number = columnNumber;

  while (number > 0) {
    const remainder =
      (number - 1) % 26;

    result =
      String.fromCharCode(
        65 + remainder
      ) +
      result;

    number = Math.floor(
      (number - remainder - 1) /
      26
    );
  }

  return result;
}
