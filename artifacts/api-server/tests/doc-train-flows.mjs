import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function fixtureSql(sql) {
  try {
    const result = await execFile("psql", [
      "-d", process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql,
    ]);
    return result.stdout;
  } catch (error) {
    // execFile errors include argv; never expose the connection string.
    throw new Error(`Doc/train fixture SQL failed (exit ${error.code ?? "unknown"})`);
  }
}

/**
 * End-to-end route coverage for the roster identity used by DocTrack and for
 * all three TrainTrack record variants. Only the document metadata prerequisite
 * is inserted directly: acknowledgements, linked sign-offs and training records
 * must all pass through their production HTTP routes.
 */
export async function testDocTrainFlows({
  managerReq,
  makeSession,
  check,
  expectOk,
  siteId,
  isoDate,
}) {
  console.log("\n── DocTrack acknowledgements & TrainTrack records ──");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the isolated document fixture");

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const me = await managerReq("GET", "/auth/me");
  expectOk("doc/train: manager session resolves", me.status);
  const currentUser = me.data?.user ?? me.data;
  const clientId = Number(currentUser?.clientId);
  if (!Number.isInteger(clientId)) throw new Error("doc/train: manager has no client context");

  const managerRoster = await managerReq("POST", "/staff-roster", {
    name: "  Manager   Acknowledged Staff  ",
    email: `doc-manager-${stamp}@test.local`,
    siteId,
  });
  expectOk("doc/train: create manager-ack roster member", managerRoster.status, [201]);
  check(
    "doc/train: roster stores canonical display name",
    managerRoster.data?.name === "Manager Acknowledged Staff",
    `got ${managerRoster.data?.name}`,
  );

  const selfEmail = `doc-self-${stamp}@test.local`;
  const selfRoster = await managerReq("POST", "/staff-roster", {
    name: "  Self   Acknowledging Staff  ",
    email: selfEmail,
    siteId,
  });
  expectOk("doc/train: create self-ack roster member", selfRoster.status, [201]);
  check(
    "doc/train: self roster stores canonical display name",
    selfRoster.data?.name === "Self Acknowledging Staff",
    `got ${selfRoster.data?.name}`,
  );

  const staffUser = await managerReq("POST", "/users", {
    name: "Different Session Display Name",
    email: selfEmail,
    password: "password-123",
    role: "client_staff",
    clientId,
    active: true,
  });
  expectOk("doc/train: create authenticated staff user", staffUser.status, [201]);

  let documentId;
  const generatedSignoffIds = [];
  const manualRecordIds = new Map();
  try {
    const insertSql = `INSERT INTO doc_track_documents
        (client_id, site_id, title, category, file_name, mime_type, object_path,
         requires_acknowledgement, annual_acknowledgement, created_by)
       VALUES (${clientId}, ${siteId}, ${sqlLiteral(`Roster identity policy ${stamp}`)},
        'policy', ${sqlLiteral(`roster-identity-${stamp}.pdf`)}, 'application/pdf',
        ${sqlLiteral(`/objects/test/doc-train-${stamp}.pdf`)}, true, false, ${Number(currentUser.id)})
       RETURNING id`;
    const inserted = await fixtureSql(insertSql);
    documentId = Number(inserted.trim().split(/\s+/)[0]);
    if (!Number.isInteger(documentId)) throw new Error("doc/train: document fixture was not created");

    let outstanding = await managerReq("GET", "/doc-track/acknowledgements/outstanding");
    expectOk("doc/train: list initial outstanding acknowledgements", outstanding.status);
    let outstandingDoc = outstanding.data?.documents?.find((row) => row.id === documentId);
    check(
      "doc/train: both new roster members start outstanding",
      outstandingDoc?.outstanding?.length === 2
        && outstandingDoc.outstanding.some((row) => row.id === managerRoster.data?.id)
        && outstandingDoc.outstanding.some((row) => row.id === selfRoster.data?.id),
      JSON.stringify(outstandingDoc),
    );

    const managerAck = await managerReq("POST", `/doc-track/documents/${documentId}/acknowledge`, {
      acknowledgements: [{
        staffRosterId: managerRoster.data?.id,
        staffName: "Forged manager acknowledgement name",
        signature: "Manager witness",
      }],
    });
    expectOk("doc/train: manager acknowledges roster member", managerAck.status, [201]);
    check("doc/train: manager acknowledgement creates one record", managerAck.data?.created === 1);
    const managerEvidence = managerAck.data?.records?.[0];
    check(
      "doc/train: manager acknowledgement persists canonical non-null roster name",
      managerEvidence?.staff_name === "Manager Acknowledged Staff"
        && typeof managerEvidence.staff_name === "string",
      `got ${managerEvidence?.staff_name}`,
    );
    if (Number.isInteger(managerEvidence?.train_track_record_id)) {
      generatedSignoffIds.push(managerEvidence.train_track_record_id);
    }

    outstanding = await managerReq("GET", "/doc-track/acknowledgements/outstanding");
    outstandingDoc = outstanding.data?.documents?.find((row) => row.id === documentId);
    check(
      "doc/train: manager acknowledgement leaves only self-ack staff outstanding",
      outstandingDoc?.outstanding?.length === 1
        && outstandingDoc.outstanding[0]?.id === selfRoster.data?.id,
      JSON.stringify(outstandingDoc),
    );

    const staffReq = makeSession();
    const staffLogin = await staffReq("POST", "/auth/login", {
      email: selfEmail,
      password: "password-123",
    });
    expectOk("doc/train: staff logs in", staffLogin.status);
    const selfAck = await staffReq("POST", `/doc-track/documents/${documentId}/acknowledge`, {
      signature: "Self signature",
      staffRosterId: managerRoster.data?.id,
      staffName: "Forged self acknowledgement name",
      acknowledgements: [{
        staffRosterId: managerRoster.data?.id,
        staffName: "Also forged",
      }],
    });
    expectOk("doc/train: authenticated staff self-acknowledges", selfAck.status, [201]);
    check("doc/train: self acknowledgement creates one record", selfAck.data?.created === 1);
    const selfEvidence = selfAck.data?.records?.[0];
    check(
      "doc/train: self acknowledgement derives roster identity and ignores forged input",
      selfEvidence?.staff_roster_id === selfRoster.data?.id
        && selfEvidence?.staff_name === "Self Acknowledging Staff"
        && selfEvidence?.staff_roster_id !== managerRoster.data?.id,
      JSON.stringify(selfEvidence),
    );
    if (Number.isInteger(selfEvidence?.train_track_record_id)) {
      generatedSignoffIds.push(selfEvidence.train_track_record_id);
    }

    const evidence = await managerReq("GET", `/doc-track/documents/${documentId}/acknowledgements`);
    expectOk("doc/train: list persisted acknowledgement evidence", evidence.status);
    check(
      "doc/train: persisted acknowledgements retain both canonical non-null names",
      evidence.data?.length === 2
        && evidence.data.every((row) => typeof row.staff_name === "string" && row.staff_name.length > 0)
        && evidence.data.some((row) => row.staff_roster_id === managerRoster.data?.id
          && row.staff_name === "Manager Acknowledged Staff")
        && evidence.data.some((row) => row.staff_roster_id === selfRoster.data?.id
          && row.staff_name === "Self Acknowledging Staff"),
      JSON.stringify(evidence.data),
    );

    outstanding = await managerReq("GET", "/doc-track/acknowledgements/outstanding");
    outstandingDoc = outstanding.data?.documents?.find((row) => row.id === documentId);
    check(
      "doc/train: manager and self acknowledgements clear the outstanding list",
      outstandingDoc?.staffTotal === 2
        && outstandingDoc?.acknowledgedCount === 2
        && outstandingDoc?.outstanding?.length === 0,
      JSON.stringify(outstandingDoc),
    );

    const variants = [
      {
        type: "certificate",
        payload: {
          recordType: "certificate",
          staffName: "Certificate Staff",
          trainingType: "Fire Safety Awareness",
          provider: "Approved Provider",
          completedDate: isoDate(-2),
          expiryDate: isoDate(365),
          siteId,
          notes: "Certificate evidence",
        },
        verify: (row) => row.record_type === "certificate"
          && row.training_type === "Fire Safety Awareness"
          && row.provider === "Approved Provider"
          && row.expiry_date?.slice(0, 10) === isoDate(365),
      },
      {
        type: "signoff",
        payload: {
          recordType: "signoff",
          staffName: "Sign-off Staff",
          documentTitle: "Manual handling procedure",
          documentType: "procedure",
          completedDate: isoDate(-1),
          siteId,
          notes: "Sign-off evidence",
        },
        verify: (row) => row.record_type === "signoff"
          && row.document_title === "Manual handling procedure"
          && row.document_type === "procedure"
          && row.training_type === null,
      },
      {
        type: "internal",
        payload: {
          recordType: "internal",
          staffName: "Internal Training Staff",
          trainingType: "Fire Safety Awareness",
          trainer: "Internal Trainer",
          completedDate: isoDate(),
          siteId,
          notes: "Internal evidence",
        },
        verify: (row) => row.record_type === "internal"
          && row.training_type === "Fire Safety Awareness"
          && row.trainer === "Internal Trainer",
      },
    ];

    for (const variant of variants) {
      const created = await managerReq("POST", "/train-track/records", variant.payload);
      expectOk(`doc/train: create ${variant.type} TrainTrack record`, created.status, [201]);
      check(
        `doc/train: ${variant.type} create persists type-specific fields`,
        Number.isInteger(created.data?.id) && variant.verify(created.data),
        JSON.stringify(created.data),
      );
      if (Number.isInteger(created.data?.id)) manualRecordIds.set(variant.type, created.data.id);
    }

    let training = await managerReq("GET", "/train-track/records");
    expectOk("doc/train: list all TrainTrack record types", training.status);
    for (const variant of variants) {
      const row = training.data?.find((record) => record.id === manualRecordIds.get(variant.type));
      check(
        `doc/train: list returns ${variant.type} type-specific fields`,
        !!row && variant.verify(row),
        JSON.stringify(row),
      );
    }

    for (const variant of variants) {
      const id = manualRecordIds.get(variant.type);
      if (!Number.isInteger(id)) continue;
      const deleted = await managerReq("DELETE", `/train-track/records/${id}`);
      check(`doc/train: delete ${variant.type} TrainTrack record`, deleted.status === 204, `got ${deleted.status}`);
    }
    training = await managerReq("GET", "/train-track/records");
    expectOk("doc/train: list TrainTrack after deletes", training.status);
    check(
      "doc/train: all three deleted record types disappear from list",
      [...manualRecordIds.values()].every((id) => !training.data?.some((record) => record.id === id)),
      JSON.stringify([...manualRecordIds.values()]),
    );
  } finally {
    if (Number.isInteger(documentId)) {
      await fixtureSql(`DELETE FROM doc_track_documents WHERE id=${documentId} AND client_id=${clientId}`);
    }
    for (const id of generatedSignoffIds) {
      await managerReq("DELETE", `/train-track/records/${id}`);
    }
  }
}
/**
 * Concurrency and fault-injection coverage for
 * POST /doc-track/documents/:id/acknowledge. Each acknowledgement writes a
 * TrainTrack sign-off and the acknowledgement row that links to it; those two
 * writes must commit together, and simultaneous manager, self and public-link
 * submissions (or retries) for one staff member must leave exactly one
 * acknowledgement and one sign-off per renewal.
 *
 * Faults are injected with a temporary trigger that rejects acknowledgement
 * rows carrying a run-specific signature, so no other run is affected. A
 * second tenant, registered by `registerTenant`, checks tenant scope.
 */
export async function testDocAckConcurrency({
  managerReq,
  makeSession,
  registerTenant,
  check,
  expectOk,
  siteId,
}) {
  console.log("\n── DocTrack acknowledgement concurrency & faults ──");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the isolated document fixture");

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const me = await managerReq("GET", "/auth/me");
  expectOk("doc-ack race: manager session resolves", me.status);
  const currentUser = me.data?.user ?? me.data;
  const clientId = Number(currentUser?.clientId);
  if (!Number.isInteger(clientId)) throw new Error("doc-ack race: manager has no client context");

  const scalar = async (sql) => (await fixtureSql(sql)).trim();
  const count = async (sql) => Number(await scalar(sql));
  const ackRows = (documentId, rosterId) => count(
    `SELECT count(*) FROM doc_acknowledgements
     WHERE document_id=${documentId} AND client_id=${clientId} AND staff_roster_id=${rosterId}`,
  );
  const signoffRows = (title, staffName) => count(
    `SELECT count(*) FROM train_track_records
     WHERE client_id=${clientId} AND record_type='signoff'
       AND document_title=${sqlLiteral(title)} AND staff_name=${sqlLiteral(staffName)}`,
  );
  const ackLink = async (documentId, rosterId) => {
    const out = await scalar(
      `SELECT a.id || '|' || COALESCE(a.train_track_record_id::text, '') || '|' || COALESCE(tr.expiry_date::text, '')
       FROM doc_acknowledgements a
       LEFT JOIN train_track_records tr ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
       WHERE a.document_id=${documentId} AND a.client_id=${clientId} AND a.staff_roster_id=${rosterId}
       ORDER BY a.id LIMIT 1`,
    );
    const [ackId, trainId, expiry] = out.split("|");
    return { ackId: Number(ackId), trainId: trainId ? Number(trainId) : null, expiry: expiry || null };
  };
  // The route dates sign-offs by the API's UTC day; annual ones expire a year later.
  const today = new Date().toISOString().slice(0, 10);
  const yearOn = await scalar(`SELECT (${sqlLiteral(today)}::date + interval '1 year')::date`);

  const roster = async (label, name, email) => {
    const res = await managerReq("POST", "/staff-roster", { name, email, siteId });
    expectOk(`doc-ack race: create roster member ${label}`, res.status, [201]);
    if (!Number.isInteger(res.data?.id)) throw new Error(`doc-ack race: roster member ${label} was not created`);
    return { id: res.data.id, name: res.data.name };
  };
  const selfEmail = `doc-race-self-${stamp}@test.local`;
  const staffA = await roster("A", "  Race   Self Staff ", selfEmail);
  const staffB = await roster("B", "Race Bulk Staff One", `doc-race-b-${stamp}@test.local`);
  const staffC = await roster("C", "Race Bulk Staff Two", `doc-race-c-${stamp}@test.local`);
  check("doc-ack race: roster keeps canonical name", staffA.name === "Race Self Staff", `got ${staffA.name}`);

  const staffUser = await managerReq("POST", "/users", {
    name: "Race Session Display Name",
    email: selfEmail,
    password: "password-123",
    role: "client_staff",
    clientId,
    active: true,
  });
  expectOk("doc-ack race: create staff login", staffUser.status, [201]);
  const staffReq = makeSession();
  expectOk("doc-ack race: staff logs in", (await staffReq("POST", "/auth/login", {
    email: selfEmail, password: "password-123",
  })).status);

  const signOff = await managerReq("POST", "/doc-track/sign-off-info");
  expectOk("doc-ack race: create public sign-off link", signOff.status, [201]);
  const signOffToken = signOff.data?.token;

  const insertDocument = async (title, annual) => {
    const out = await fixtureSql(`INSERT INTO doc_track_documents
        (client_id, site_id, title, category, file_name, mime_type, object_path,
         requires_acknowledgement, annual_acknowledgement, created_by)
       VALUES (${clientId}, ${siteId}, ${sqlLiteral(title)}, 'policy',
        ${sqlLiteral(`race-${stamp}.pdf`)}, 'application/pdf',
        ${sqlLiteral(`/objects/test/doc-race-${stamp}-${annual ? "annual" : "once"}.pdf`)},
        true, ${annual ? "true" : "false"}, ${Number(currentUser.id)})
       RETURNING id`);
    const id = Number(out.trim().split(/\s+/)[0]);
    if (!Number.isInteger(id)) throw new Error("doc-ack race: document fixture was not created");
    return id;
  };

  const faultMarker = `fault-${stamp}`;
  const faultFn = `test_doc_ack_fault_${stamp}`;
  const faultTrigger = `test_doc_ack_fault_trg_${stamp}`;
  const documentIds = [];
  try {
    const onceTitle = `Race once policy ${stamp}`;
    const annualTitle = `Race annual policy ${stamp}`;
    const onceDoc = await insertDocument(onceTitle, false);
    documentIds.push(onceDoc);
    const annualDoc = await insertDocument(annualTitle, true);
    documentIds.push(annualDoc);
    const ackPath = (documentId) => `/doc-track/documents/${documentId}/acknowledge`;
    const managerAck = (documentId, rosterIds, signature = "Manager witness") => managerReq("POST", ackPath(documentId), {
      acknowledgements: rosterIds.map((staffRosterId) => ({ staffRosterId, staffName: "Forged name", signature })),
    });
    const selfAck = (documentId, signature = "Self signature") => staffReq("POST", ackPath(documentId), { signature });
    const createdTotal = (results) => results.reduce((sum, r) => sum + (Number(r.data?.created) || 0), 0);

    // 1. Simultaneous manager, self and public-link submissions for one person.
    const publicAck = () => managerReq("POST", `/sign-off/${signOffToken}/acknowledge`, {
      documentType: "doc", documentId: onceDoc, staffRosterId: staffA.id, typedName: "Race Self Staff",
    });
    const [race, publicRace] = await Promise.all([
      Promise.all([
        managerAck(onceDoc, [staffA.id]),
        selfAck(onceDoc),
        managerAck(onceDoc, [staffA.id]),
        selfAck(onceDoc),
        managerAck(onceDoc, [staffA.id]),
        selfAck(onceDoc),
      ]),
      Promise.all([publicAck(), publicAck()]),
    ]);
    check(
      "doc-ack race: simultaneous submissions all succeed",
      race.every((r) => r.status === 201) && publicRace.every((r) => r.status === 200 || r.status === 201),
      JSON.stringify([...race, ...publicRace].map((r) => r.status)),
    );
    check(
      "doc-ack race: exactly one submission records the acknowledgement",
      createdTotal(race) + publicRace.filter((r) => r.status === 201).length === 1,
      `created ${createdTotal(race)}, public ${JSON.stringify(publicRace.map((r) => r.status))}`,
    );
    check("doc-ack race: one acknowledgement row", await ackRows(onceDoc, staffA.id) === 1, `got ${await ackRows(onceDoc, staffA.id)}`);
    check("doc-ack race: one TrainTrack sign-off", await signoffRows(onceTitle, staffA.name) === 1, `got ${await signoffRows(onceTitle, staffA.name)}`);
    let link = await ackLink(onceDoc, staffA.id);
    check("doc-ack race: one-off sign-off has no expiry", link.trainId !== null && link.expiry === null, JSON.stringify(link));

    // 2. A retry after success is a no-op.
    const retry = await managerAck(onceDoc, [staffA.id]);
    expectOk("doc-ack race: retry after success", retry.status, [201]);
    check("doc-ack race: retry creates nothing", retry.data?.created === 0, `created ${retry.data?.created}`);
    check(
      "doc-ack race: retry leaves one acknowledgement and one sign-off",
      await ackRows(onceDoc, staffA.id) === 1 && await signoffRows(onceTitle, staffA.name) === 1,
    );

    // 3. Overlapping bulk sign-offs in opposite orders (and a duplicated id) neither
    // deadlock nor duplicate.
    const bulk = await Promise.all([
      managerAck(onceDoc, [staffB.id, staffC.id]),
      managerAck(onceDoc, [staffC.id, staffB.id]),
      managerAck(onceDoc, [staffB.id, staffB.id, staffC.id]),
      managerAck(onceDoc, [staffC.id, staffB.id]),
    ]);
    check("doc-ack race: overlapping bulk sign-offs succeed", bulk.every((r) => r.status === 201), JSON.stringify(bulk.map((r) => r.status)));
    check("doc-ack race: overlapping bulk sign-offs record each person once", createdTotal(bulk) === 2, `created ${createdTotal(bulk)}`);
    for (const staff of [staffB, staffC]) {
      check(
        `doc-ack race: bulk leaves one acknowledgement and one sign-off for ${staff.name}`,
        await ackRows(onceDoc, staff.id) === 1 && await signoffRows(onceTitle, staff.name) === 1,
        `acks ${await ackRows(onceDoc, staff.id)}, sign-offs ${await signoffRows(onceTitle, staff.name)}`,
      );
    }

    // 4. Acknowledgement persistence fails on a first sign-off: no orphan TrainTrack record.
    await fixtureSql(`CREATE FUNCTION ${faultFn}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'injected doc acknowledgement fault'; END $f$;
      CREATE TRIGGER ${faultTrigger} BEFORE INSERT OR UPDATE ON doc_acknowledgements
        FOR EACH ROW WHEN (NEW.signature = ${sqlLiteral(faultMarker)}) EXECUTE FUNCTION ${faultFn}();`);
    const failedFirst = await managerAck(annualDoc, [staffB.id], faultMarker);
    check("doc-ack race: injected fault surfaces as a server error", failedFirst.status >= 500, `got ${failedFirst.status}`);
    check(
      "doc-ack race: failed first sign-off leaves no acknowledgement and no orphan TrainTrack record",
      await ackRows(annualDoc, staffB.id) === 0 && await signoffRows(annualTitle, staffB.name) === 0,
      `acks ${await ackRows(annualDoc, staffB.id)}, sign-offs ${await signoffRows(annualTitle, staffB.name)}`,
    );
    const retryFirst = await managerAck(annualDoc, [staffB.id]);
    check("doc-ack race: retry after a failed sign-off records it once", retryFirst.status === 201 && retryFirst.data?.created === 1, `${retryFirst.status} created ${retryFirst.data?.created}`);
    link = await ackLink(annualDoc, staffB.id);
    check(
      "doc-ack race: retried annual sign-off is linked and expires a year on",
      await signoffRows(annualTitle, staffB.name) === 1 && link.trainId !== null && link.expiry === yearOn,
      JSON.stringify({ link, yearOn }),
    );

    // 5. Annual renewal: a failed renewal keeps the old link; simultaneous renewals add one.
    const firstAnnual = await selfAck(annualDoc);
    check("doc-ack race: self annual sign-off", firstAnnual.status === 201 && firstAnnual.data?.created === 1, `${firstAnnual.status}`);
    const original = await ackLink(annualDoc, staffA.id);
    // Simulate the year passing on this sign-off.
    await fixtureSql(`UPDATE train_track_records SET expiry_date = CURRENT_DATE - 1
      WHERE id=${original.trainId} AND client_id=${clientId}`);
    const failedRenewal = await managerAck(annualDoc, [staffA.id], faultMarker);
    check("doc-ack race: injected renewal fault surfaces as a server error", failedRenewal.status >= 500, `got ${failedRenewal.status}`);
    link = await ackLink(annualDoc, staffA.id);
    check(
      "doc-ack race: failed renewal keeps the expired link and adds no TrainTrack record",
      link.ackId === original.ackId && link.trainId === original.trainId
        && await signoffRows(annualTitle, staffA.name) === 1,
      JSON.stringify({ original, link, signoffs: await signoffRows(annualTitle, staffA.name) }),
    );
    await fixtureSql(`DROP TRIGGER IF EXISTS ${faultTrigger} ON doc_acknowledgements; DROP FUNCTION IF EXISTS ${faultFn}();`);

    const renewals = await Promise.all([
      managerAck(annualDoc, [staffA.id]),
      selfAck(annualDoc),
      managerAck(annualDoc, [staffA.id]),
      selfAck(annualDoc),
    ]);
    check("doc-ack race: simultaneous renewals succeed", renewals.every((r) => r.status === 201), JSON.stringify(renewals.map((r) => r.status)));
    check("doc-ack race: simultaneous renewals renew once", createdTotal(renewals) === 1, `created ${createdTotal(renewals)}`);
    link = await ackLink(annualDoc, staffA.id);
    check(
      "doc-ack race: renewal updates the same acknowledgement to a new sign-off a year on",
      await ackRows(annualDoc, staffA.id) === 1 && link.ackId === original.ackId
        && link.trainId !== original.trainId && link.expiry === yearOn,
      JSON.stringify({ original, link, yearOn }),
    );
    check(
      "doc-ack race: renewal keeps the expired sign-off as history and adds exactly one",
      await signoffRows(annualTitle, staffA.name) === 2
        && await count(`SELECT count(*) FROM train_track_records WHERE id=${original.trainId} AND client_id=${clientId}`) === 1,
      `sign-offs ${await signoffRows(annualTitle, staffA.name)}`,
    );

    // 6. Tenant scope: another business can neither sign nor read these documents.
    const otherReq = await registerTenant("doc-ack-other");
    const otherRoster = await otherReq("POST", "/staff-roster", { name: "Other Tenant Staff", email: `doc-race-other-${stamp}@test.local` });
    expectOk("doc-ack race: other tenant creates roster member", otherRoster.status, [201]);
    const before = await count(`SELECT count(*) FROM doc_acknowledgements WHERE document_id=${onceDoc}`);
    const foreign = await Promise.all([
      otherReq("POST", ackPath(onceDoc), { acknowledgements: [{ staffRosterId: staffB.id, staffName: "x" }] }),
      otherReq("POST", ackPath(onceDoc), { acknowledgements: [{ staffRosterId: otherRoster.data?.id, staffName: "x" }] }),
      otherReq("GET", `/doc-track/documents/${onceDoc}/acknowledgements`),
    ]);
    check("doc-ack race: other tenant gets 404 for this business's document", foreign.every((r) => r.status === 404), JSON.stringify(foreign.map((r) => r.status)));
    check(
      "doc-ack race: other tenant attempts write nothing",
      await count(`SELECT count(*) FROM doc_acknowledgements WHERE document_id=${onceDoc}`) === before
        && await count(`SELECT count(*) FROM train_track_records WHERE document_title IN (${sqlLiteral(onceTitle)}, ${sqlLiteral(annualTitle)}) AND client_id <> ${clientId}`) === 0,
    );
  } finally {
    await fixtureSql(`DROP TRIGGER IF EXISTS ${faultTrigger} ON doc_acknowledgements; DROP FUNCTION IF EXISTS ${faultFn}();`);
    for (const id of documentIds) {
      await fixtureSql(`DELETE FROM doc_track_documents WHERE id=${id} AND client_id=${clientId}`);
    }
  }
}
