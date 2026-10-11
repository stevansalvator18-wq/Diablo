const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const workCategories = [
  ['voirie', 'Voirie'],
  ['eau-potable', 'Eau potable'],
  ['assainissement', 'Assainissement'],
  ['electricite', 'Électricité'],
  ['telecommunications', 'Télécommunications'],
  ['eclairage-public', 'Éclairage public'],
  ['espaces-publics', 'Espaces publics'],
  ['autre', 'Autre']
];

const categoryIds = new Map(workCategories.map(([code], index) => [code, index + 1]));

function saveGuCase(database, guCase) {
  database.exec('BEGIN IMMEDIATE');

  try {
    const existingCase = guCase.id == null
      ? null
      : database.prepare(
        'SELECT id FROM gu_cases WHERE id = ?'
      ).get(guCase.id);

    if (guCase.id != null && !existingCase) {
      throw new Error('Le dossier GU chargé n’existe plus. Rechargez la liste.');
    }

    if (guCase.reference !== null) {
      const referenceOwner = database.prepare(
        'SELECT id FROM gu_cases WHERE reference = ?'
      ).get(guCase.reference);
      if (referenceOwner && referenceOwner.id !== guCase.id) {
        throw new Error('Cette référence existe déjà. Choisissez une référence différente.');
      }
    }

    if (guCase.id == null &&
        guCase.reference === null && guCase.companyName === null) {
      const existingUnidentifiedCase = database.prepare(`
        SELECT id FROM gu_cases
        WHERE reference IS NULL AND company_name IS NULL
        ORDER BY id
        LIMIT 1
      `).get();

      if (existingUnidentifiedCase) {
        database.exec('ROLLBACK');
        return {
          duplicateEmptyIdentity: true,
          existingCaseId: Number(existingUnidentifiedCase.id)
        };
      }
    }

    let caseId;
    if (existingCase) {
      caseId = existingCase.id;
      database.prepare(`
        UPDATE gu_cases
        SET reference = ?, company_name = ?, tax_rate_percent = ?, advance_rate_percent = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        guCase.reference,
        guCase.companyName,
        guCase.taxRatePercent,
        guCase.advanceRatePercent,
        caseId
      );
      database.prepare('DELETE FROM invoices WHERE gu_case_id = ?').run(caseId);
    } else {
      caseId = database.prepare(`
        INSERT INTO gu_cases (
          reference, company_name, tax_rate_percent, advance_rate_percent
        ) VALUES (?, ?, ?, ?)
      `).run(
        guCase.reference,
        guCase.companyName,
        guCase.taxRatePercent,
        guCase.advanceRatePercent
      ).lastInsertRowid;
    }

    const insertInvoice = database.prepare(`
      INSERT INTO invoices (gu_case_id, category_id, description, amount_minor)
      VALUES (?, ?, ?, ?)
    `);

    for (const invoice of guCase.invoices) {
      insertInvoice.run(
        caseId,
        categoryIds.get(invoice.categoryCode),
        invoice.description,
        invoice.amountMinor
      );
    }

    database.exec('COMMIT');
    return { id: Number(caseId), reference: guCase.reference };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function searchGuCases(database, query) {
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;

  return database.prepare(`
    SELECT id, reference, company_name AS companyName
    FROM gu_cases
    WHERE reference LIKE ? ESCAPE '\\'
       OR company_name LIKE ? ESCAPE '\\'
    ORDER BY reference COLLATE NOCASE
    LIMIT 50
  `).all(pattern, pattern);
}

function listGuCases(database) {
  return database.prepare(`
    SELECT id, reference, company_name AS companyName
    FROM gu_cases
    ORDER BY reference IS NOT NULL DESC, reference COLLATE NOCASE, id
  `).all();
}

function listAvailableGuCases(database, recCaseId = null) {
  return database.prepare(`
    SELECT gu_cases.id, gu_cases.reference,
           gu_cases.company_name AS companyName,
           gu_cases.case_date AS caseDate,
           COUNT(invoices.id) AS invoiceCount,
           COALESCE(SUM(invoices.amount_minor), 0) AS estimatedCostMinor
    FROM gu_cases
    LEFT JOIN rec_cases ON rec_cases.gu_case_id = gu_cases.id
    LEFT JOIN invoices ON invoices.gu_case_id = gu_cases.id
    WHERE rec_cases.id IS NULL OR rec_cases.id = ?
    GROUP BY gu_cases.id
    ORDER BY gu_cases.reference IS NOT NULL DESC,
             gu_cases.reference COLLATE NOCASE,
             gu_cases.id
  `).all(recCaseId);
}

function validateRecReference(reference) {
  if (typeof reference !== 'string') {
    throw new Error('مرجع ملف التكلفة الحقيقية مطلوب.');
  }

  const normalized = reference.trim();
  if (!normalized || normalized.length > 100) {
    throw new Error('مرجع ملف التكلفة الحقيقية مطلوب، ويجب ألا يتجاوز 100 حرف.');
  }
  return normalized;
}

function createRecCase(database, recCase) {
  const reference = validateRecReference(recCase.reference);
  recCase = { ...recCase, reference };
  database.exec('BEGIN IMMEDIATE');

  try {
    if (recCase.guCaseId !== null) {
      const guCase = database.prepare(
        'SELECT id FROM gu_cases WHERE id = ?'
      ).get(recCase.guCaseId);
      if (!guCase) {
        throw new Error('ملف التكلفة التقديرية المحدد غير موجود. حدّث القائمة.');
      }

      const existingRecCase = database.prepare(
        'SELECT id FROM rec_cases WHERE gu_case_id = ?'
      ).get(guCase.id);
      if (existingRecCase) {
        throw new Error('ملف التكلفة التقديرية مرتبط بالفعل بملف تكلفة حقيقية.');
      }
    }

    const referenceOwner = database.prepare(
      'SELECT id FROM rec_cases WHERE reference = ?'
    ).get(recCase.reference);
    if (referenceOwner) {
      throw new Error('مرجع التكلفة الحقيقية مستخدم بالفعل. أدخل مرجعاً آخر.');
    }

    const result = database.prepare(`
      INSERT INTO rec_cases (reference, gu_case_id, tax_rate_percent, lot_name)
      VALUES (?, ?, ?, ?)
    `).run(recCase.reference, recCase.guCaseId, 5, recCase.lotName);

    const recCaseId = Number(result.lastInsertRowid);
    insertRecInvoices(database, recCaseId, recCase.invoices);

    database.exec('COMMIT');
    return {
      id: recCaseId,
      reference: recCase.reference,
      guCaseId: recCase.guCaseId
    };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function insertRecInvoices(database, recCaseId, invoices) {
  const insertInvoice = database.prepare(`
    INSERT INTO invoices (rec_case_id, category_id, description, amount_minor)
    VALUES (?, ?, ?, ?)
  `);

  for (const invoice of invoices) {
    insertInvoice.run(
      recCaseId,
      categoryIds.get(invoice.categoryCode),
      invoice.description,
      invoice.amountMinor
    );
  }
}

function updateRecCase(database, recCase) {
  const reference = validateRecReference(recCase.reference);
  recCase = { ...recCase, reference };
  database.exec('BEGIN IMMEDIATE');

  try {
    const existing = database.prepare(
      'SELECT id, gu_case_id FROM rec_cases WHERE id = ?'
    ).get(recCase.id);
    if (!existing) throw new Error('ملف التكلفة الحقيقية غير موجود. حدّث القائمة.');
    if (recCase.guCaseId !== null) {
      const guCase = database.prepare(
        'SELECT id FROM gu_cases WHERE id = ?'
      ).get(recCase.guCaseId);
      if (!guCase) {
        throw new Error('ملف التكلفة التقديرية المحدد غير موجود. حدّث القائمة.');
      }

      const existingRecCase = database.prepare(
        'SELECT id FROM rec_cases WHERE gu_case_id = ? AND id <> ?'
      ).get(recCase.guCaseId, recCase.id);
      if (existingRecCase) {
        throw new Error('ملف التكلفة التقديرية مرتبط بالفعل بملف تكلفة حقيقية.');
      }
    }

    const referenceOwner = database.prepare(
      'SELECT id FROM rec_cases WHERE reference = ? AND id <> ?'
    ).get(recCase.reference, recCase.id);
    if (referenceOwner) {
      throw new Error('مرجع التكلفة الحقيقية مستخدم بالفعل. أدخل مرجعاً آخر.');
    }

    database.prepare(`
      UPDATE rec_cases
      SET reference = ?, gu_case_id = ?, lot_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(recCase.reference, recCase.guCaseId, recCase.lotName, recCase.id);

    database.prepare('DELETE FROM invoices WHERE rec_case_id = ?').run(recCase.id);
    insertRecInvoices(database, recCase.id, recCase.invoices);
    database.exec('COMMIT');
    return { id: recCase.id, reference: recCase.reference, guCaseId: recCase.guCaseId };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function updateRecGuLink(database, recCaseId, guCaseId) {
  database.exec('BEGIN IMMEDIATE');

  try {
    const recCase = database.prepare(
      'SELECT id FROM rec_cases WHERE id = ?'
    ).get(recCaseId);
    if (!recCase) throw new Error('ملف التكلفة الحقيقية غير موجود. حدّث القائمة.');

    if (guCaseId !== null) {
      const guCase = database.prepare(
        'SELECT id FROM gu_cases WHERE id = ?'
      ).get(guCaseId);
      if (!guCase) {
        throw new Error('ملف التكلفة التقديرية المحدد غير موجود. حدّث القائمة.');
      }

      const existingRecCase = database.prepare(
        'SELECT id FROM rec_cases WHERE gu_case_id = ? AND id <> ?'
      ).get(guCaseId, recCaseId);
      if (existingRecCase) {
        throw new Error('ملف التكلفة التقديرية مرتبط بالفعل بملف تكلفة حقيقية.');
      }
    }

    database.prepare(`
      UPDATE rec_cases
      SET gu_case_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(guCaseId, recCaseId);
    database.exec('COMMIT');
    return { id: recCaseId, guCaseId };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function listRecCases(database) {
  return database.prepare(`
    SELECT rec_cases.id, rec_cases.reference, rec_cases.lot_name AS lotName,
           rec_cases.gu_case_id AS guCaseId,
           gu_cases.reference AS guReference,
           gu_cases.company_name AS guCompanyName,
           COUNT(invoices.id) AS invoiceCount
    FROM rec_cases
    LEFT JOIN gu_cases ON gu_cases.id = rec_cases.gu_case_id
    LEFT JOIN invoices ON invoices.rec_case_id = rec_cases.id
    GROUP BY rec_cases.id
    ORDER BY rec_cases.id DESC
  `).all();
}

function loadRecCase(database, recCaseId) {
  const recCase = database.prepare(`
    SELECT rec_cases.id, rec_cases.reference, rec_cases.lot_name AS lotName,
           rec_cases.gu_case_id AS guCaseId,
           rec_cases.tax_rate_percent AS taxRatePercent,
           gu_cases.reference AS guReference,
           gu_cases.company_name AS guCompanyName,
           (SELECT COALESCE(SUM(amount_minor), 0)
            FROM invoices WHERE gu_case_id = rec_cases.gu_case_id) AS estimatedCostMinor
    FROM rec_cases
    LEFT JOIN gu_cases ON gu_cases.id = rec_cases.gu_case_id
    WHERE rec_cases.id = ?
  `).get(recCaseId);

  if (!recCase) return null;

  const invoices = database.prepare(`
    SELECT categories.code AS category_code, invoices.description,
           invoices.amount_minor
    FROM invoices
    JOIN work_categories AS categories ON categories.id = invoices.category_id
    WHERE invoices.rec_case_id = ?
    ORDER BY categories.sort_order, invoices.id
  `).all(recCaseId).map((invoice) => ({
    categoryCode: invoice.category_code,
    description: invoice.description,
    amountMinor: invoice.amount_minor
  }));

  return { ...recCase, invoices };
}

function comparisonResult(referenceTotalMinor, invoiceTotalMinor) {
  const differenceMinor = invoiceTotalMinor - referenceTotalMinor;
  return {
    invoiceTotalMinor,
    differenceMinor,
    differencePercent: referenceTotalMinor === 0
      ? null
      : differenceMinor / referenceTotalMinor * 100,
    resultStatus: differenceMinor === 0 ? 'identical' : 'review'
  };
}

function comparisonInvoicesTotal(invoices) {
  return invoices.reduce((total, invoice) => total + invoice.amountMinor, 0);
}

function snapshotRecCase(recCase) {
  const actualTotalMinor = comparisonInvoicesTotal(recCase.invoices);
  return {
    sourceRecCaseId: recCase.id,
    reference: recCase.reference,
    lotName: recCase.lotName,
    guCaseId: recCase.guCaseId,
    guReference: recCase.guReference,
    guCompanyName: recCase.guCompanyName,
    estimatedCostMinor: recCase.estimatedCostMinor,
    taxRatePercent: recCase.taxRatePercent,
    invoiceCount: recCase.invoices.length,
    actualTotalMinor,
    invoices: recCase.invoices
  };
}

function validateComparisonInvoices(invoices) {
  if (!Array.isArray(invoices) || invoices.length > 2000) {
    throw new Error('قائمة فواتير المقارنة غير صالحة.');
  }

  return invoices.map((invoice) => {
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
      throw new Error('بيانات إحدى فواتير المقارنة غير صالحة.');
    }
    if (typeof invoice.description !== 'string' || invoice.description.trim().length > 500) {
      throw new Error('وصف إحدى فواتير المقارنة غير صالح.');
    }
    if (!Number.isSafeInteger(invoice.amountMinor) || invoice.amountMinor < 0) {
      throw new Error('يجب أن يكون مبلغ فاتورة المقارنة موجباً أو صفراً ومحدداً بالسنتيم.');
    }

    return {
      categoryCode: workCategories.some(([code]) => code === invoice.categoryCode)
        ? invoice.categoryCode
        : 'autre',
      description: invoice.description.trim(),
      amountMinor: invoice.amountMinor
    };
  });
}

function listComparisons(database) {
  return database.prepare(`
    SELECT id, name, source_rec_case_id AS sourceRecCaseId,
           source_reference AS sourceReference, source_lot_name AS sourceLotName,
           reference_total_minor AS referenceTotalMinor,
           invoice_total_minor AS invoiceTotalMinor,
           difference_minor AS differenceMinor,
           difference_percent AS differencePercent,
           result_status AS resultStatus, updated_at AS updatedAt
    FROM comparisons
    ORDER BY updated_at DESC, id DESC
  `).all();
}

function loadComparison(database, comparisonId) {
  const comparison = database.prepare(`
    SELECT id, name, source_rec_case_id AS sourceRecCaseId,
           source_reference AS sourceReference, source_lot_name AS sourceLotName,
           source_snapshot AS sourceSnapshot,
           reference_total_minor AS referenceTotalMinor,
           invoice_total_minor AS invoiceTotalMinor,
           difference_minor AS differenceMinor,
           difference_percent AS differencePercent,
           result_status AS resultStatus, created_at AS createdAt,
           updated_at AS updatedAt
    FROM comparisons
    WHERE id = ?
  `).get(comparisonId);

  if (!comparison) return null;
  const { sourceSnapshot, ...loadedComparison } = comparison;
  loadedComparison.sourceSnapshot = JSON.parse(sourceSnapshot);
  loadedComparison.invoices = database.prepare(`
    SELECT category_code AS categoryCode, description, amount_minor AS amountMinor
    FROM comparison_invoices
    WHERE comparison_id = ?
    ORDER BY id
  `).all(comparisonId);
  return loadedComparison;
}

function saveComparison(database, comparison) {
  const name = typeof comparison.name === 'string' ? comparison.name.trim() : '';
  if (!name || name.length > 200) {
    throw new Error('اسم المقارنة مطلوب ويجب ألا يتجاوز 200 حرف.');
  }
  const invoices = validateComparisonInvoices(comparison.invoices);
  database.exec('BEGIN IMMEDIATE');

  try {
    const invoiceTotalMinor = comparisonInvoicesTotal(invoices);
    let comparisonId;
    let referenceTotalMinor;
    let sourceSnapshot;
    let sourceRecCaseId;
    let sourceReference;
    let sourceLotName;

    if (comparison.id == null) {
      if (!Number.isSafeInteger(comparison.sourceRecCaseId) || comparison.sourceRecCaseId <= 0) {
        throw new Error('ملف التكلفة الحقيقية المرجعي غير صالح.');
      }
      const sourceRecCase = loadRecCase(database, comparison.sourceRecCaseId);
      if (!sourceRecCase) throw new Error('ملف التكلفة الحقيقية المرجعي غير موجود.');

      sourceSnapshot = snapshotRecCase(sourceRecCase);
      sourceRecCaseId = sourceRecCase.id;
      sourceReference = sourceRecCase.reference;
      sourceLotName = sourceRecCase.lotName;
      referenceTotalMinor = sourceSnapshot.actualTotalMinor;

      const result = comparisonResult(referenceTotalMinor, invoiceTotalMinor);
      const inserted = database.prepare(`
        INSERT INTO comparisons (
          name, source_rec_case_id, source_reference, source_lot_name, source_snapshot,
          reference_total_minor, invoice_total_minor, difference_minor,
          difference_percent, result_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name,
        sourceRecCaseId,
        sourceReference,
        sourceLotName,
        JSON.stringify(sourceSnapshot),
        referenceTotalMinor,
        result.invoiceTotalMinor,
        result.differenceMinor,
        result.differencePercent,
        result.resultStatus
      );
      comparisonId = Number(inserted.lastInsertRowid);
    } else {
      if (!Number.isSafeInteger(comparison.id) || comparison.id <= 0) {
        throw new Error('معرّف المقارنة غير صالح.');
      }
      const existing = database.prepare(`
        SELECT source_rec_case_id AS sourceRecCaseId,
               source_reference AS sourceReference, source_lot_name AS sourceLotName,
               source_snapshot AS sourceSnapshot, reference_total_minor AS referenceTotalMinor
        FROM comparisons WHERE id = ?
      `).get(comparison.id);
      if (!existing) throw new Error('المقارنة المحفوظة غير موجودة.');

      comparisonId = comparison.id;
      sourceRecCaseId = existing.sourceRecCaseId;
      sourceReference = existing.sourceReference;
      sourceLotName = existing.sourceLotName;
      sourceSnapshot = JSON.parse(existing.sourceSnapshot);
      referenceTotalMinor = existing.referenceTotalMinor;
      const result = comparisonResult(referenceTotalMinor, invoiceTotalMinor);
      database.prepare(`
        UPDATE comparisons
        SET name = ?, invoice_total_minor = ?, difference_minor = ?,
            difference_percent = ?, result_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        name,
        result.invoiceTotalMinor,
        result.differenceMinor,
        result.differencePercent,
        result.resultStatus,
        comparisonId
      );
    }

    database.prepare('DELETE FROM comparison_invoices WHERE comparison_id = ?').run(comparisonId);
    const insertInvoice = database.prepare(`
      INSERT INTO comparison_invoices (comparison_id, category_code, description, amount_minor)
      VALUES (?, ?, ?, ?)
    `);
    invoices.forEach((invoice) => insertInvoice.run(
      comparisonId,
      invoice.categoryCode,
      invoice.description,
      invoice.amountMinor
    ));
    database.exec('COMMIT');
    return loadComparison(database, comparisonId);
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067) {
      throw new Error('اسم المقارنة مستخدم من قبل. اختر اسماً آخر.');
    }
    throw error;
  }
}

function loadGuCase(database, guCaseId) {
  const guCase = database.prepare(`
    SELECT id, reference, company_name, tax_rate_percent, advance_rate_percent
    FROM gu_cases
    WHERE id = ?
  `).get(guCaseId);

  if (!guCase) return null;

  const invoices = database.prepare(`
    SELECT categories.code AS category_code, invoices.description,
           invoices.amount_minor
    FROM invoices
    JOIN work_categories AS categories ON categories.id = invoices.category_id
    WHERE invoices.gu_case_id = ?
    ORDER BY categories.sort_order, invoices.id
  `).all(guCase.id).map((invoice) => ({
    categoryCode: invoice.category_code,
    description: invoice.description,
    amountMinor: invoice.amount_minor
  }));

  return {
    id: guCase.id,
    reference: guCase.reference,
    companyName: guCase.company_name,
    taxRatePercent: guCase.tax_rate_percent,
    advanceRatePercent: guCase.advance_rate_percent,
    invoices
  };
}

function deleteGuCase(database, guCaseId) {
  database.exec('BEGIN IMMEDIATE');

  try {
    const guCase = database.prepare(
      'SELECT id FROM gu_cases WHERE id = ?'
    ).get(guCaseId);
    if (!guCase) throw new Error('Ce dossier GU n’existe plus. Actualisez la liste.');

    const linkedRecCase = database.prepare(
      'SELECT 1 FROM rec_cases WHERE gu_case_id = ? LIMIT 1'
    ).get(guCaseId);
    const linkedPayment = database.prepare(
      'SELECT 1 FROM payments WHERE gu_case_id = ? LIMIT 1'
    ).get(guCaseId);
    if (linkedRecCase || linkedPayment) {
      throw new Error('Suppression refusée : ce dossier GU est lié à un dossier REC ou à un paiement.');
    }

    database.prepare('DELETE FROM invoices WHERE gu_case_id = ?').run(guCaseId);
    const result = database.prepare('DELETE FROM gu_cases WHERE id = ?').run(guCaseId);
    if (result.changes !== 1) {
      throw new Error('Le dossier GU n’a pas pu être supprimé.');
    }

    database.exec('COMMIT');
    return { id: guCaseId };
  } catch (error) {
    database.exec('ROLLBACK');
    if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw new Error('Suppression refusée par une contrainte de la base. Les données liées ont été conservées.');
    }
    throw error;
  }
}

const migrations = [
  {
    version: 1,
    up(database) {
      database.exec(`
        CREATE TABLE work_categories (
          id INTEGER PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL UNIQUE,
          sort_order INTEGER NOT NULL UNIQUE CHECK (sort_order >= 0)
        ) STRICT;

        CREATE TABLE settings (
          setting_key TEXT PRIMARY KEY,
          setting_value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;

        CREATE TABLE gu_cases (
          id INTEGER PRIMARY KEY,
          reference TEXT NOT NULL UNIQUE
            CHECK (length(trim(reference)) > 0),
          company_name TEXT NOT NULL
            CHECK (length(trim(company_name)) > 0),
          case_date TEXT,
          observations TEXT NOT NULL DEFAULT '',
          tax_rate_percent REAL NOT NULL CHECK (tax_rate_percent >= 0),
          advance_rate_percent REAL NOT NULL CHECK (advance_rate_percent >= 0),
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;

        CREATE TABLE rec_cases (
          id INTEGER PRIMARY KEY,
          reference TEXT NOT NULL UNIQUE
            CHECK (length(trim(reference)) > 0),
          gu_case_id INTEGER NOT NULL
            REFERENCES gu_cases(id) ON DELETE RESTRICT,
          case_date TEXT,
          observations TEXT NOT NULL DEFAULT '',
          tax_rate_percent REAL NOT NULL CHECK (tax_rate_percent >= 0),
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;

        CREATE TABLE invoices (
          id INTEGER PRIMARY KEY,
          gu_case_id INTEGER REFERENCES gu_cases(id) ON DELETE RESTRICT,
          rec_case_id INTEGER REFERENCES rec_cases(id) ON DELETE RESTRICT,
          category_id INTEGER NOT NULL
            REFERENCES work_categories(id) ON DELETE RESTRICT,
          description TEXT NOT NULL DEFAULT '',
          amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK (
            (gu_case_id IS NOT NULL AND rec_case_id IS NULL) OR
            (gu_case_id IS NULL AND rec_case_id IS NOT NULL)
          )
        ) STRICT;

        CREATE TABLE payments (
          id INTEGER PRIMARY KEY,
          gu_case_id INTEGER REFERENCES gu_cases(id) ON DELETE RESTRICT,
          rec_case_id INTEGER REFERENCES rec_cases(id) ON DELETE RESTRICT,
          payment_kind TEXT NOT NULL CHECK (
            payment_kind IN ('advance', 'regularization_received', 'refund_issued')
          ),
          payment_date TEXT NOT NULL,
          reference TEXT,
          amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK (
            (payment_kind = 'advance' AND gu_case_id IS NOT NULL AND rec_case_id IS NULL) OR
            (payment_kind IN ('regularization_received', 'refund_issued') AND
              gu_case_id IS NULL AND rec_case_id IS NOT NULL)
          )
        ) STRICT;

        CREATE INDEX idx_rec_cases_gu_case_id ON rec_cases(gu_case_id);
        CREATE INDEX idx_invoices_gu_case_id ON invoices(gu_case_id);
        CREATE INDEX idx_invoices_rec_case_id ON invoices(rec_case_id);
        CREATE INDEX idx_payments_gu_case_id ON payments(gu_case_id);
        CREATE INDEX idx_payments_rec_case_id ON payments(rec_case_id);
      `);

      const insertCategory = database.prepare(
        'INSERT INTO work_categories (code, label, sort_order) VALUES (?, ?, ?)'
      );
      workCategories.forEach(([code, label], index) => {
        insertCategory.run(code, label, index);
      });

      const insertSetting = database.prepare(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)'
      );
      [
        ['tax_rate_percent', '5'],
        ['advance_rate_percent', '75'],
        ['currency', 'MAD'],
        ['commune_name', '']
      ].forEach(([key, value]) => insertSetting.run(key, value));
    }
  },
  {
    version: 2,
    backupBefore: true,
    disableForeignKeys: true,
    up(database) {
      database.exec(`
        CREATE TABLE gu_cases_v2 (
          id INTEGER PRIMARY KEY,
          reference TEXT UNIQUE
            CHECK (reference IS NULL OR length(trim(reference)) > 0),
          company_name TEXT
            CHECK (company_name IS NULL OR length(trim(company_name)) > 0),
          case_date TEXT,
          observations TEXT NOT NULL DEFAULT '',
          tax_rate_percent REAL NOT NULL CHECK (tax_rate_percent >= 0),
          advance_rate_percent REAL NOT NULL CHECK (advance_rate_percent >= 0),
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;

        INSERT INTO gu_cases_v2 (
          id, reference, company_name, case_date, observations,
          tax_rate_percent, advance_rate_percent, status, created_at, updated_at
        )
        SELECT
          id,
          CASE WHEN reference IS NULL OR length(trim(reference)) = 0
            THEN NULL ELSE reference END,
          CASE WHEN company_name IS NULL OR length(trim(company_name)) = 0
            THEN NULL ELSE company_name END,
          case_date, observations, tax_rate_percent, advance_rate_percent,
          status, created_at, updated_at
        FROM gu_cases;

        DROP TABLE gu_cases;
        ALTER TABLE gu_cases_v2 RENAME TO gu_cases;
      `);
    }
  },
  {
    version: 3,
    backupBefore: true,
    up(database) {
      database.exec(`
        CREATE UNIQUE INDEX ux_rec_cases_gu_case_id
        ON rec_cases(gu_case_id)
      `);
    }
  },
  {
    version: 4,
    backupBefore: true,
    up(database) {
      database.exec(`
        ALTER TABLE rec_cases
        ADD COLUMN lot_name TEXT NOT NULL DEFAULT ''
      `);
    }
  },
  {
    version: 5,
    backupBefore: true,
    disableForeignKeys: true,
    up(database) {
      database.exec(`
        CREATE TABLE rec_cases_v5 (
          id INTEGER PRIMARY KEY,
          reference TEXT NOT NULL UNIQUE
            CHECK (length(trim(reference)) > 0),
          gu_case_id INTEGER
            REFERENCES gu_cases(id) ON DELETE RESTRICT,
          case_date TEXT,
          observations TEXT NOT NULL DEFAULT '',
          tax_rate_percent REAL NOT NULL CHECK (tax_rate_percent >= 0),
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          lot_name TEXT NOT NULL DEFAULT ''
        ) STRICT;

        INSERT INTO rec_cases_v5 (
          id, reference, gu_case_id, case_date, observations,
          tax_rate_percent, status, created_at, updated_at, lot_name
        )
        SELECT
          id, reference, gu_case_id, case_date, observations,
          tax_rate_percent, status, created_at, updated_at, lot_name
        FROM rec_cases;

        DROP TABLE rec_cases;
        ALTER TABLE rec_cases_v5 RENAME TO rec_cases;

        CREATE INDEX idx_rec_cases_gu_case_id
        ON rec_cases(gu_case_id);
        CREATE UNIQUE INDEX ux_rec_cases_gu_case_id
        ON rec_cases(gu_case_id);
      `);
    }
  },
  {
    version: 6,
    backupBefore: true,
    up(database) {
      database.exec(`
        CREATE TABLE comparisons (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
          source_rec_case_id INTEGER NOT NULL,
          source_reference TEXT NOT NULL,
          source_lot_name TEXT NOT NULL,
          source_snapshot TEXT NOT NULL CHECK (json_valid(source_snapshot)),
          reference_total_minor INTEGER NOT NULL CHECK (reference_total_minor >= 0),
          invoice_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (invoice_total_minor >= 0),
          difference_minor INTEGER NOT NULL DEFAULT 0,
          difference_percent REAL,
          result_status TEXT NOT NULL CHECK (result_status IN ('identical', 'review')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;

        CREATE TABLE comparison_invoices (
          id INTEGER PRIMARY KEY,
          comparison_id INTEGER NOT NULL
            REFERENCES comparisons(id) ON DELETE CASCADE,
          category_code TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0)
        ) STRICT;

        CREATE INDEX idx_comparison_invoices_comparison_id
        ON comparison_invoices(comparison_id);
      `);
    }
  }
];

async function initializeDatabase(databasePath) {
  const databaseExisted = fs.existsSync(databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);

  try {
    const migrationTableExists = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_migrations'
    `).get();
    const currentVersion = migrationTableExists
      ? database.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
      ).get().version
      : 0;
    const latestVersion = migrations.at(-1)?.version ?? 0;

    if (currentVersion > latestVersion) {
      throw new Error(
        `La base utilise une version de schéma plus récente (${currentVersion}).`
      );
    }

    const pendingMigrations = migrations.filter(
      (migration) => migration.version > currentVersion
    );
    const backupMigration = pendingMigrations.find((migration) => migration.backupBefore);

    if (databaseExisted && backupMigration) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${databasePath}.before-v${backupMigration.version}-${timestamp}.bak`;
      await backup(database, backupPath);

      const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
      try {
        const backupCheck = backupDatabase.prepare('PRAGMA quick_check').get().quick_check;
        if (backupCheck !== 'ok') {
          throw new Error('La sauvegarde préalable à la migration n’est pas intègre.');
        }
      } finally {
        backupDatabase.close();
      }
    }

    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);

    for (const migration of pendingMigrations) {
      if (migration.disableForeignKeys) {
        database.exec('PRAGMA foreign_keys = OFF');
      }

      try {
        database.exec('BEGIN IMMEDIATE');
        migration.up(database);

        const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
        if (foreignKeyErrors.length > 0) {
          throw new Error('La migration créerait des liens de dossiers invalides.');
        }

        database.prepare(
          'INSERT INTO schema_migrations (version) VALUES (?)'
        ).run(migration.version);
        database.exec('COMMIT');
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {}
        throw error;
      } finally {
        if (migration.disableForeignKeys) {
          database.exec('PRAGMA foreign_keys = ON');
        }
      }
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

module.exports = {
  initializeDatabase,
  createRecCase,
  updateRecCase,
  updateRecGuLink,
  listRecCases,
  loadRecCase,
  listGuCases,
  listAvailableGuCases,
  deleteGuCase,
  loadGuCase,
  saveGuCase,
  searchGuCases,
  listComparisons,
  loadComparison,
  saveComparison
};