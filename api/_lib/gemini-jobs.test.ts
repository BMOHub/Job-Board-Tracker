import assert from "node:assert/strict";
import test from "node:test";
import { parseEvidenceBackedJobs, type SourceDocument } from "./gemini-jobs.js";

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
