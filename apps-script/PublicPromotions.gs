var PUBLIC_PROMOTIONS_SETTINGS = Object.freeze({
  spreadsheetId: "1YQBSm6XcdGgqB3hflV_4vAG27oqRC0eSQ6Fv3rwL3KI",
  sheetName: "โปรโมชั่น",
  route: "public-promotions",
  activeStatus: "ใช้งาน",
  columnCount: 14,
  timeZone: "Asia/Bangkok"
});

/** This project had no doGet(e) before the public promotions endpoint was added. */
function doGet(e) {
  var publicPromotionsOutput = routePublicPromotionsGet_(e);
  if (publicPromotionsOutput) return publicPromotionsOutput;
  return publicPromotionsJsonOutput_({ ok: false, error: "NOT_FOUND" });
}

/**
 * Safe routing hook for an existing doGet(e).
 * Return null when this file does not own the requested route.
 */
function routePublicPromotionsGet_(e) {
  var route = e && e.parameter ? String(e.parameter.route || "").trim() : "";
  if (route !== PUBLIC_PROMOTIONS_SETTINGS.route) return null;
  return handlePublicPromotionsGet_();
}

/** Returns only the whitelisted, currently active promotion fields as JSON. */
function handlePublicPromotionsGet_() {
  try {
    return publicPromotionsJsonOutput_({
      ok: true,
      promotions: listPublicPromotions_()
    });
  } catch (error) {
    console.error("Public promotions read failed");
    return publicPromotionsJsonOutput_({
      ok: false,
      promotions: [],
      error: "PROMOTIONS_UNAVAILABLE"
    });
  }
}

function listPublicPromotions_(now) {
  var spreadsheet = SpreadsheetApp.openById(PUBLIC_PROMOTIONS_SETTINGS.spreadsheetId);
  var sheet = spreadsheet.getSheetByName(PUBLIC_PROMOTIONS_SETTINGS.sheetName);
  if (!sheet) throw new Error("Promotion sheet not found");

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var timeZone = PUBLIC_PROMOTIONS_SETTINGS.timeZone;
  var today = publicPromotionDateKey_(now || new Date(), timeZone);
  var rows = sheet.getRange(2, 1, lastRow - 1, PUBLIC_PROMOTIONS_SETTINGS.columnCount).getValues();

  return rows.reduce(function (result, row) {
    var status = publicPromotionText_(row[13]);
    var startDate = publicPromotionDateKey_(row[11], timeZone);
    var endDate = publicPromotionDateKey_(row[12], timeZone);
    if (status !== PUBLIC_PROMOTIONS_SETTINGS.activeStatus) return result;
    if (!startDate || !endDate || today < startDate || today > endDate) return result;

    var code = publicPromotionText_(row[0]);
    var name = publicPromotionText_(row[1]);
    if (!code || !name) return result;

    result.push({
      code: code,
      name: name,
      purchaseProductCode: publicPromotionText_(row[2]),
      minimumQuantity: publicPromotionNumber_(row[3]),
      type: publicPromotionText_(row[4]),
      giftProductCode: publicPromotionText_(row[5]),
      giftQuantity: publicPromotionNumber_(row[6]),
      specialPrice: publicPromotionNumber_(row[7]),
      specialPriceMode: publicPromotionText_(row[8]),
      pointsMultiplier: publicPromotionNumber_(row[9]),
      repeatByQuantity: publicPromotionText_(row[10]) === "ใช่",
      startDate: startDate,
      endDate: endDate,
      status: PUBLIC_PROMOTIONS_SETTINGS.activeStatus
    });
    return result;
  }, []);
}

function publicPromotionText_(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function publicPromotionNumber_(value) {
  if (value === "" || value === null || value === undefined) return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function publicPromotionDateKey_(value, timeZone) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timeZone, "yyyy-MM-dd");
  }

  var raw = publicPromotionText_(value);
  if (!raw) return "";
  if (/^\d+(\.\d+)?$/.test(raw)) {
    var serialDate = new Date(Date.UTC(1899, 11, 30) + Number(raw) * 86400000);
    return Utilities.formatDate(serialDate, "UTC", "yyyy-MM-dd");
  }

  var iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return iso[1] + "-" + publicPromotionPad_(iso[2]) + "-" + publicPromotionPad_(iso[3]);

  var thai = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (thai) {
    var year = Number(thai[3]) > 2400 ? Number(thai[3]) - 543 : Number(thai[3]);
    return year + "-" + publicPromotionPad_(thai[2]) + "-" + publicPromotionPad_(thai[1]);
  }
  return "";
}

function publicPromotionPad_(value) {
  return ("0" + Number(value)).slice(-2);
}

function publicPromotionsJsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
