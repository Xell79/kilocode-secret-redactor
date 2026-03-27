import { describe, expect, it } from "vitest";
import { detectSecrets } from "./detector.js";

describe("detectSecrets", () => {
  it("detects a JWT token", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const results = detectSecrets(`token: ${jwt}`);

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^jwt_/);
    expect(results[0].value).toBe(jwt);
  });

  it("detects a GitLab PAT", () => {
    const pat = "glpat-xyzABCDEFGH12345678901234";
    const results = detectSecrets(pat);

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^gitlab_pat_/);
  });

  it("detects a GitLab pipeline trigger token", () => {
    const token = "glptt-abcdefghijklmnopqrstuvwx";
    const results = detectSecrets(token);

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^gitlab_pipeline_trigger_/);
  });

  it("detects a GitHub PAT", () => {
    const pat = "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";
    const results = detectSecrets(pat);

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^github_pat_/);
  });

  it("detects a gcloud access token", () => {
    const token = "ya29.a0ARrdaM8abc123def456ghi789jkl012mno345pqr678stu901vwx234yz";
    const results = detectSecrets(token);

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^gcloud_access_token_/);
  });

  it("detects an AWS access key", () => {
    const results = detectSecrets("key: AKIAIOSFODNN7EXAMPLE");

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^aws_access_key_/);
  });

  it("detects an AWS secret key with context", () => {
    const results = detectSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^aws_secret_key_/);
    expect(results[0].value).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });

  it("does not false-positive on random UUIDs", () => {
    const results = detectSecrets("id: 550e8400-e29b-41d4-a716-446655440000");

    const herokuMatch = results.find((r) => r.label.startsWith("heroku"));
    expect(herokuMatch).toBeUndefined();
  });

  it("detects multiple secrets in one text", () => {
    const text = [
      "glpat-xyzABCDEFGH12345678901234",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234",
    ].join(" and ");

    const results = detectSecrets(text);

    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("detects a database connection string", () => {
    const results = detectSecrets("postgres://admin:s3cretP4ss@db.example.com:5432/mydb");

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^database_url_/);
  });

  it("detects a private key block", () => {
    const key =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBANLJhPHhITqQbPklG3ibCVxwGMRfp/v4XqhfdQHdcVfHap6NQ5Wo\nk/4xIA+ui35/MmNartNuC+BdMhz+dl2qNh0CAwEAAQ==\n-----END RSA PRIVATE KEY-----";
    const results = detectSecrets(key);

    expect(results).toHaveLength(1);
    expect(results[0].label).toMatch(/^private_key_/);
  });

  it("ignores strings shorter than minimum length", () => {
    const results = detectSecrets("sk-abc");

    expect(results).toHaveLength(0);
  });
});
