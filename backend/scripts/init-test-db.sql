-- Runs once when the postgres container's data volume is first created.
-- Provisions a second database for the test suite alongside the dev DB.
CREATE DATABASE football_quiz_test;
