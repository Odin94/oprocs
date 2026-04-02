import { describe, it, expect } from "vitest";
import { normalizeCmdForPlatform } from "../config.js";

describe("normalizeCmdForPlatform", () => {
    describe("on non-Windows platforms", () => {
        it("rewrites cmd /c to sh -c on linux", () => {
            const result = normalizeCmdForPlatform(["cmd", "/c", "cd backend && npm run dev"], "linux");
            expect(result).toEqual(["sh", "-c", "cd backend && npm run dev"]);
        });

        it("rewrites cmd /c to sh -c on darwin", () => {
            const result = normalizeCmdForPlatform(["cmd", "/c", "cd frontend && npm start"], "darwin");
            expect(result).toEqual(["sh", "-c", "cd frontend && npm start"]);
        });

        it("is case-insensitive for CMD /C", () => {
            const result = normalizeCmdForPlatform(["CMD", "/C", "echo hello"], "linux");
            expect(result).toEqual(["sh", "-c", "echo hello"]);
        });

        it("joins multiple args after /c with a space", () => {
            const result = normalizeCmdForPlatform(["cmd", "/c", "cd backend", "&&", "npm run dev"], "linux");
            expect(result).toEqual(["sh", "-c", "cd backend && npm run dev"]);
        });

        it("returns null for commands that are not cmd /c", () => {
            const result = normalizeCmdForPlatform(["node", "server.js"], "linux");
            expect(result).toBeNull();
        });

        it("returns null for a lone cmd without /c", () => {
            const result = normalizeCmdForPlatform(["cmd"], "linux");
            expect(result).toBeNull();
        });
    });

    describe("on Windows", () => {
        it("does not rewrite cmd /c on win32", () => {
            const result = normalizeCmdForPlatform(["cmd", "/c", "cd backend && npm run dev"], "win32");
            expect(result).toBeNull();
        });
    });
});
