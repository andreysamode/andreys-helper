// swift-tools-version:5.9
import PackageDescription

// SwiftPM manifest for the AndreysOrchestrator ("The Circle") — PLAN.md §7.
// A single macOS executable. SwiftTerm is wired in now so the orchestrator
// host (W5) is unblocked; it is not used yet.
let package = Package(
    name: "AndreysOrchestrator",
    platforms: [
        .macOS(.v13)
    ],
    dependencies: [
        .package(
            url: "https://github.com/migueldeicaza/SwiftTerm",
            from: "1.2.0"
        )
    ],
    targets: [
        .executableTarget(
            name: "AndreysOrchestrator",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm")
            ],
            path: "Sources/AndreysOrchestrator",
            // moon.png — the moon-mode circle face (Sources/…/Resources).
            // SwiftPM emits it as AndreysOrchestrator_AndreysOrchestrator.bundle
            // next to the binary; build-app.sh copies that into the .app's
            // Contents/Resources, which is where `MoonArt` looks for it.
            resources: [
                .process("Resources")
            ]
        )
    ]
)
