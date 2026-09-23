import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GEMINI_MODEL,
  describeGeminiError,
  extractLikelyCareerLinks,
  parseAdpJobs,
  parseEvidenceBackedJobs,
  parseTaleoJobs,
  parseUkgJobs,
  requestGeminiWithRetry,
  scanJobsForEmployer,
  type SourceDocument,
} from "./gemini-jobs.js";
import { isVerifiedScanResult } from "../../src/services/jobScanner.js";

test("uses a stable current Gemini model by default", () => {
  assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.5-flash-lite");
});

test("turns Gemini authentication and quota failures into actionable safe messages", () => {
  assert.match(
    describeGeminiError({ status: 401, message: "API key not valid" }),
    /Replace GEMINI_API_KEY in Vercel/,
  );
  const quotaMessage = describeGeminiError({ status: 429, message: "RESOURCE_EXHAUSTED" });
  assert.match(quotaMessage, /free Gemini quota or rate limit/i);
  assert.doesNotMatch(quotaMessage, /billing/i);
  assert.match(describeGeminiError({ status: 503 }), /temporarily unavailable after retries/i);
});

test("reports an unavailable configured model without returning the raw SDK error", () => {
  const message = describeGeminiError({
    status: 404,
    message: "models/gemini-3.5-flash-lite is not found for API version v1beta; internal trace secret-123",
  });

  assert.match(message, /gemini-3.5-flash-lite is unavailable/i);
  assert.doesNotMatch(message, /secret-123/);
});

test("retries Gemini 503 twice but never retries free-tier quota errors", async () => {
  let attempts = 0;
  assert.equal(await requestGeminiWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw { status: 503 };
    return "recovered";
  }, 0), "recovered");
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(requestGeminiWithRetry(async () => {
    attempts += 1;
    throw { status: 429 };
  }, 0), (error: any) => error.status === 429);
  assert.equal(attempts, 1);
});

test("neither individual nor group scans treat unverified empty results as success", () => {
  assert.equal(isVerifiedScanResult({ jobs: [], source: "no-jobs-found", authoritative: false,
    warning: "Reader unavailable" }), false);
  assert.equal(isVerifiedScanResult({ jobs: [], source: "official-page", authoritative: true }), true);
  assert.equal(isVerifiedScanResult({ jobs: [{ title: "Open job" }], source: "official-page",
    authoritative: true }), true);
});

const source: SourceDocument = {
  url: "https://example.org/careers",
  text: `
    # Open positions
    [Community Outreach Coordinator](/jobs/community-outreach)
    Philadelphia, PA · Full-time

    [Expired Program Assistant](/jobs/old-assistant)
    This posting has expired.
  `,
};

test("keeps a job only when its title and URL are supported by the fetched page", () => {
  const jobs = parseEvidenceBackedJobs(JSON.stringify([
    {
      title: "Community Outreach Coordinator",
      url: "/jobs/community-outreach",
      sourceUrl: source.url,
      location: "Philadelphia, PA",
      city: "Philadelphia",
      roleType: "Full-time",
      postedDate: "",
      description: "Coordinates community outreach.",
    },
    {
      title: "Invented Executive Role",
      url: "/jobs/invented",
      sourceUrl: source.url,
      location: "Philadelphia, PA",
      city: "Philadelphia",
      roleType: "Full-time",
      postedDate: "",
      description: "Not present in the source.",
    },
  ]), [source]);

  assert.deepEqual(jobs.map((job) => job.title), ["Community Outreach Coordinator"]);
  assert.equal(jobs[0].url, "https://example.org/jobs/community-outreach");
});

test("rejects postings with nearby explicit closed evidence", () => {
  const jobs = parseEvidenceBackedJobs(JSON.stringify([{
    title: "Expired Program Assistant",
    url: "/jobs/old-assistant",
    sourceUrl: source.url,
    location: "Philadelphia, PA",
    city: "Philadelphia",
    roleType: "Full-time",
    postedDate: "",
    description: "",
  }]), [source]);

  assert.deepEqual(jobs, []);
});

test("rejects a URL that was not present in the cited source", () => {
  const jobs = parseEvidenceBackedJobs(JSON.stringify([{
    title: "Community Outreach Coordinator",
    url: "https://malicious.example/jobs/123",
    sourceUrl: source.url,
    location: "Philadelphia, PA",
    city: "Philadelphia",
    roleType: "Full-time",
    postedDate: "",
    description: "",
  }]), [source]);

  assert.deepEqual(jobs, []);
});

test("discovers official ATS and job-search links without following unrelated links", () => {
  const links = extractLikelyCareerLinks({
    url: "https://example.org/careers",
    text: `
      [Open Positions in Philadelphia](https://workforcenow.adp.com/recruitment/jobs?client=example)
      [Search and Apply For Jobs](https://example.org/careers/search-and-apply-jobs)
      [Benefits](https://example.org/about/benefits)
      [Instagram](https://instagram.com/example)
    `,
  });

  assert.deepEqual(links, [
    "https://workforcenow.adp.com/recruitment/jobs?client=example",
    "https://example.org/careers/search-and-apply-jobs",
  ]);
});

test("discovers ATS links in raw HTML returned by the reader fallback", () => {
  const links = extractLikelyCareerLinks({
    url: "https://example.org/careers",
    text: '<a class="button" href="https://temple.taleo.net/careersection/jobs/jobsearch.ftl?lang=en">External Candidate</a>',
  });

  assert.deepEqual(links, [
    "https://temple.taleo.net/careersection/jobs/jobsearch.ftl?lang=en",
  ]);
});

test("maps only local currently listed Taleo jobs to official detail pages", () => {
  const jobs = parseTaleoJobs({ requisitionList: [
    { contestNo: "26002340", column: ["Driver/Groundskeeper", "26002340", '["United States-Pennsylvania-Philadelphia"]'] },
    { contestNo: "26002341", column: ["Boston role", "26002341", '["United States-Massachusetts-Boston"]'] },
    { contestNo: "26002342", column: ["Unspecified PA", "26002342", '["United States-Location INSIDE of PA"]'] },
    { contestNo: "bad/value", column: ["Unsafe URL", "", '["United States-Pennsylvania-Philadelphia"]'] },
  ] }, "https://temple.taleo.net/careersection/tu_ex_staff/jobsearch.ftl?lang=en");
  assert.deepEqual(jobs, [{
    title: "Driver/Groundskeeper", city: "Philadelphia", location: "Philadelphia, PA",
    url: "https://temple.taleo.net/careersection/tu_ex_staff/jobdetail.ftl?job=26002340&lang=en",
    roleType: "Not specified", postedDate: "", description: "",
  }]);
});

test("uses School District of Philadelphia's official Taleo school locations", () => {
  const board = "https://aa080.taleo.net/careersection/sdp_external_career_section/jobsearch.ftl";
  const payload = { requisitionList: [
    { contestNo: "50032551", locationsColumns: [1], column: ["7-8 Math Teacher",
      '["Alternative Middle Years at James Martin (5430)"]', "Sep 23, 2026"] },
    { contestNo: "50032552", locationsColumns: [1], column: ["Missing location", "[]", "Sep 23, 2026"] },
    { contestNo: "50032553", locationsColumns: [1], column: ["Other state", '["United States-Massachusetts-Boston"]', "Sep 23, 2026"] },
  ] };
  assert.deepEqual(parseTaleoJobs(payload, board), []);
  const jobs = parseTaleoJobs(payload, board, true);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].city, "Philadelphia");
  assert.match(jobs[0].location, /James Martin.*Philadelphia, PA/);
  assert.match(jobs[0].url, /sdp_external_career_section\/jobdetail\.ftl\?job=50032551/);
  assert.deepEqual(parseTaleoJobs(payload, "https://other.taleo.net/careersection/other/jobsearch.ftl", true), []);
});

test("follows Temple's official search page and combines paginated Taleo boards without Gemini", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("https://careers.temple.edu/")) return new Response(
      "Temple University Careers. Search official open positions for staff and faculty. " +
      "[Search and Apply For Jobs](https://careers.temple.edu/careers-temple/search-and-apply-jobs) More information.");
    if (url.endsWith("https://careers.temple.edu/careers-temple/search-and-apply-jobs")) return new Response(
      "[External Candidate](https://temple.taleo.net/careersection/tu_ex_staff/jobsearch.ftl?lang=en)\n" +
      "[Faculty Jobs](https://temple.taleo.net/careersection/tu_ex_faculty/jobsearch.ftl?lang=en)\n" +
      "[Adjunct Jobs](https://temple.taleo.net/careersection/tu_ex_adjunct/jobsearch.ftl?lang=en)");
    if (url.includes("/careersection/") && url.includes("/jobsearch.ftl")) return new Response(
      "<script>var settings={portalNo: '8100123629'};</script>");
    if (url.includes("/rest/jobboard/searchjobs")) {
      const board = String(init?.headers && (init.headers as Record<string, string>).Referer || "");
      const pageNo = JSON.parse(String(init?.body)).pageNo;
      const prefix = board.includes("staff") ? "staff" : board.includes("faculty") ? "faculty" : "adjunct";
      const requisitionList = pageNo === 1 ? [{ contestNo: `${prefix}-1`,
        column: [`${prefix} job`, "", '["United States-Pennsylvania-Philadelphia"]'] }] :
        prefix === "staff" ? [{ contestNo: "staff-2", column: ["Second staff job", "", '["United States-Pennsylvania-Philadelphia"]'] }] : [];
      return Response.json({ requisitionList, pagingData: { pageSize: 1, totalCount: prefix === "staff" ? 2 : 1 } });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await scanJobsForEmployer("Temple University", "https://careers.temple.edu/");
    assert.equal(result.source, "official-page");
    assert.equal(result.jobs.length, 4);
    assert.ok(requests.some((url) => url.includes("/rest/jobboard/searchjobs")));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("replaces verified stale career URLs stored on existing employers", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response("Official site currently unavailable", { status: 503 });
  };
  try {
    await scanJobsForEmployer("University of Pennsylvania (UPenn)", "https://careers.upenn.edu/");
    await scanJobsForEmployer("World Affairs Council", "https://wacphila.org/about/careers/");
    assert.ok(requests.some((url) => url === "https://www.hr.upenn.edu/PennHR/careers-at-penn"));
    assert.ok(requests.some((url) => url === "https://wacphila.org/join-our-team/"));
    assert.equal(requests.some((url) => url.includes("careers.upenn.edu/")), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("extracts only Greater Philadelphia jobs from an official ADP response", () => {
  const jobs = parseAdpJobs({
    jobRequisitions: [
      {
        itemID: "regional-job_1",
        requisitionTitle: "Mechanical Engineer",
        postDate: "2026-09-20T12:00:00Z",
        workLevelCode: { shortName: "Full-time" },
        requisitionLocations: [{
          address: {
            cityName: "Wayne",
            countrySubdivisionLevel1: { codeValue: "PA" },
            postalCode: "19087",
          },
        }],
      },
      {
        itemID: "remote-job_1",
        requisitionTitle: "Engineer in Boston",
        requisitionLocations: [{
          address: {
            cityName: "Boston",
            countrySubdivisionLevel1: { codeValue: "MA" },
            postalCode: "02111",
          },
        }],
      },
      {
        itemID: "mismatched-title_1",
        requisitionTitle: "Engineer - Arlington, VA",
        requisitionLocations: [{
          address: {
            cityName: "Wayne",
            countrySubdivisionLevel1: { codeValue: "PA" },
            postalCode: "19087",
          },
        }],
      },
    ],
  }, "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=client&ccId=center");

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Mechanical Engineer");
  assert.equal(jobs[0].location, "Wayne, PA");
  assert.match(jobs[0].url, /jobId=regional-job_1/);
});

test("discovers Rivers Casino's official UKG board from its careers page", () => {
  const links = extractLikelyCareerLinks({
    url: "https://www.riverscasino.com/philadelphia/careers",
    text: '<a href="https://rushst.rec.pro.ukg.net/RIV1014RIVCA/JobBoard/27a20bf0-126e-44c7-a462-00944f601b0c/?q=&amp;f4=location">Open Positions</a>',
  });
  assert.deepEqual(links, [
    "https://rushst.rec.pro.ukg.net/RIV1014RIVCA/JobBoard/27a20bf0-126e-44c7-a462-00944f601b0c/?q=&f4=location",
  ]);
});

test("finds Rivers UKG jobs in official HTML even if the intermediary Reader fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://www.riverscasino.com/philadelphia/careers") return new Response(
      '<html><body><h1>Rivers Casino Philadelphia Careers</h1><a href="https://rushst.rec.pro.ukg.net/RIV1014RIVCA/JobBoard/27a20bf0-126e-44c7-a462-00944f601b0c/?q=&amp;f4=location">Open Positions</a></body></html>',
      { headers: { "Content-Type": "text/html" } });
    if (url.includes("/JobBoardView/LoadSearchResults")) return Response.json({ opportunities: [{
      Id: "8d27e1ef-97d9-416a-9139-075f06aac400", Title: "PT Cashier Flipt", FullTime: false,
      Locations: [{ Address: { City: "Philadelphia", State: { Code: "PA" }, PostalCode: "19125" } }],
    }] });
    if (url.startsWith("https://r.jina.ai/")) return new Response("Reader unavailable", { status: 503 });
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await scanJobsForEmployer("Rivers Casino", "https://www.riverscasino.com/philadelphia/careers");
    assert.equal(result.jobs.length, 1);
    assert.equal(result.source, "official-page");
    assert.equal(result.authoritative, true);
    assert.equal(requests.some((url) => url.startsWith("https://r.jina.ai/")), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("maps official UKG opportunities without including other casino cities or fake positions", () => {
  const board = "https://rushst.rec.pro.ukg.net/RIV1014RIVCA/JobBoard/27a20bf0-126e-44c7-a462-00944f601b0c/?f4=location";
  const jobs = parseUkgJobs({ opportunities: [
    {
      Id: "8d27e1ef-97d9-416a-9139-075f06aac400", Title: "PT Cashier Flipt",
      FullTime: false, PostedDate: "2026-09-22T18:41:02.312Z", BriefDescription: "Guest service",
      Locations: [{ Address: { City: "Philadelphia", State: { Code: "PA" }, PostalCode: "19125" } }],
    },
    {
      Id: "8d27e1ef-97d9-416a-9139-075f06aac400", Title: "PT Cashier Flipt",
      Locations: [{ Address: { City: "Philadelphia", State: { Code: "PA" } } }],
    },
    {
      Id: "14318a95-c193-4cf1-ae06-f40444fe2d03", Title: "Poker Dealer",
      Locations: [{ Address: { City: "Portsmouth", State: { Code: "VA" } } }],
    },
    {
      Id: "fcfba8f9-6bed-44a9-81e3-cb5a1148987d", Title: "Fake Philadelphia, TX",
      Locations: [{ Address: { City: "Philadelphia", State: { Code: "TX" } } }],
    },
    { Id: "not-a-real-id", Title: "Invented", Locations: [] },
  ] }, board);

  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    title: "PT Cashier Flipt",
    url: "https://rushst.rec.pro.ukg.net/RIV1014RIVCA/JobBoard/27a20bf0-126e-44c7-a462-00944f601b0c/OpportunityDetail?opportunityId=8d27e1ef-97d9-416a-9139-075f06aac400",
    location: "Philadelphia, PA", city: "Philadelphia", roleType: "Part-time",
    postedDate: "2026-09-22T18:41:02.312Z", description: "Guest service",
  });
});
