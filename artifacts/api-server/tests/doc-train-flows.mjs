import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { completeTwoFactor } from "./two-factor-fixture.mjs";
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
    await completeTwoFactor(staffReq, staffLogin, { label: "doc/train staff" });
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