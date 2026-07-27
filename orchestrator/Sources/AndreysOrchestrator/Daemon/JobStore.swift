// Persistent job store — `~/.andreys-helper/jobs.json` (PLAN.md §6.5, §8 W4).
//
// Loads the job array on start and persists on every change. The on-disk shape
// is exactly the Codable `Job` from Protocol.swift.

import Foundation

public final class JobStore {
    private let url: URL
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()
    private let decoder = JSONDecoder()

    public private(set) var jobs: [Job] = []

    public init(url: URL = Bootstrap.baseDir.appendingPathComponent("jobs.json")) {
        self.url = url
        load()
    }

    public func load() {
        guard let data = try? Data(contentsOf: url),
            let decoded = try? decoder.decode([Job].self, from: data)
        else {
            jobs = []
            return
        }
        jobs = decoded
    }

    private func save() {
        guard let data = try? encoder.encode(jobs) else { return }
        try? data.write(to: url, options: .atomic)
    }

    public func upsert(_ job: Job) {
        if let idx = jobs.firstIndex(where: { $0.id == job.id }) {
            jobs[idx] = job
        } else {
            jobs.append(job)
        }
        save()
    }

    public func remove(id: String) {
        jobs.removeAll { $0.id == id }
        save()
    }

    public func replaceAll(_ newJobs: [Job]) {
        jobs = newJobs
        save()
    }
}
