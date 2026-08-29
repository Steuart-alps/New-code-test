// Self-booted RoomTrack smoke/integration coverage. Run with:
// API_BASE=http://localhost:8080/api node tests/room-track-routes.mjs
const BASE = process.env.API_BASE || "http://localhost:8080/api";
const failures = [];
function check(name, yes) { if (!yes) failures.push(name); }
function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: (response.headers.get("content-type") || "").includes("json") ? await response.json() : null };
  };
}
async function register(req, suffix) {
  const email = `roomtrack-${Date.now()}-${suffix}@test.local`;
  let result = await req("POST", "/auth/register", { name: "RoomTrack test", email, password: "password-123" });
  if (result.data?.verificationToken) {
    await req("GET", `/auth/verify-email?token=${encodeURIComponent(result.data.verificationToken)}`);
  }
  result = await req("POST", "/auth/login", { email, password: "password-123" });
  return result.status;
}
async function main() {
  const a = session(); check("register primary client", [200, 201].includes(await register(a, "a")));
  const site = await a("POST", "/sites", { name: "RoomTrack site" });
  check("create site", site.status === 201);
  const room = await a("POST", "/room-track/rooms", { roomNumber: "101", name: "Suite", floor: "1", siteId: site.data?.id });
  check("manager can create room", room.status === 201 && room.data?.roomNumber === "101");
  const day = new Date().toISOString().slice(0, 10);
  for (const criterion of ["clean", "tidy", "toStandard"]) {
    const target = criterion === "clean" ? room : await a("POST", "/room-track/rooms", { roomNumber: `10${criterion.length}`, siteId: site.data?.id });
    const r = await a("POST", "/room-track/checks", { roomId: target.data?.id, checkDate: day, [criterion]: true });
    check(`create partial ${criterion} check`, r.status === 201 && r.data?.[criterion] === true);
  }
  const duplicate = await a("POST", "/room-track/checks", { roomId: room.data?.id, checkDate: day, clean: true });
  check("duplicate room/day is preserved", duplicate.status === 409);
  const checks = (await a("GET", `/room-track/checks?date=${day}`)).data;
  for (const item of checks) {
    const put = await a("PUT", `/room-track/checks/${item.id}`, { clean: true, tidy: true, toStandard: true });
    check("explicit PUT completes same-day check", put.status === 200 && put.data?.clean && put.data?.tidy && put.data?.toStandard);
  }
  const summary = await a("GET", `/room-track/daily/summary?date=${day}&siteId=${site.data?.id}`);
  check("daily summary counts rooms", summary.status === 200 && summary.data?.checked === 3 && summary.data?.total === 3);
  const secondSite = await a("POST", "/sites", { name: "RoomTrack second site" });
  check("create second site", secondSite.status === 201);
  const secondRoom = await a("POST", "/room-track/rooms", { roomNumber: "201", siteId: secondSite.data?.id });
  const secondCheck = await a("POST", "/room-track/checks", {
    roomId: secondRoom.data?.id, checkDate: day, clean: true, tidy: true, toStandard: true,
  });
  check("create completed second-site check", secondCheck.status === 201);
  const secondSummary = await a("GET", `/room-track/daily/summary?date=${day}&siteId=${secondSite.data?.id}`);
  check("site summary excludes other-site rooms", secondSummary.status === 200 && secondSummary.data?.checked === 1 && secondSummary.data?.total === 1);
  const b = session(); check("register second client", [200, 201].includes(await register(b, "b")));
  const foreign = await b("GET", `/room-track/rooms/${room.data?.id}`);
  check("tenant isolation hides room", foreign.status === 404);
  const remove = await a("DELETE", `/room-track/rooms/${room.data?.id}`);
  check("manager can archive room", remove.status === 200 && remove.data?.active === false);
  const history = await a("GET", `/room-track/checks?date=${day}&roomId=${room.data?.id}`);
  check("archived room checks remain readable", history.status === 200 && history.data?.length === 1);
  const activeRooms = await a("GET", "/room-track/rooms?active=true");
  check("archived room absent from active list", activeRooms.status === 200 && !activeRooms.data?.some((item) => item.id === room.data?.id));
  if (failures.length) throw new Error(failures.join("; "));
}
main().catch((error) => { console.error(error); process.exit(1); });