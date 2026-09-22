import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GEMINI_MODEL,
  describeGeminiError,
  extractLikelyCareerLinks,
  parseAdpJobs,
  parseEvidenceBackedJobs,
  type SourceDocument,
} from "./gemini-jobs.js";

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
});

test("reports an unavailable configured model without returning the raw SDK error", () => {
  const message = describeGeminiError({
    status: 404,
    message: "models/gemini-3.5-flash-lite is not found for API version v1beta; internal trace secret-123",
  });

  assert.match(message, /gemini-3.5-flash-lite is unavailable/i);
  assert.doesNotMatch(message, /secret-123/);
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
