// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RadioKit",
    defaultLocalization: "en",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "RadioKit", targets: ["RadioKit"])
    ],
    dependencies: [
        // Pinned to exact commits by Package.resolved at the closeout macOS build:
        // neither package can be resolved from the Windows planning host.
        .package(url: "https://github.com/google/nearby.git", branch: "main"),
        .package(url: "https://github.com/alta/swift-opus.git", branch: "main")
    ],
    targets: [
        .target(
            name: "OpusShim",
            dependencies: [
                .product(name: "Copus", package: "swift-opus")
            ]
        ),
        .target(name: "MallocCompatShim"),
        .target(
            name: "RadioKit",
            dependencies: [
                .product(name: "NearbyConnections", package: "nearby"),
                .product(name: "Opus", package: "swift-opus"),
                "OpusShim",
                "MallocCompatShim"
            ]
            // No `resources:` — the only localized strings this package ever
            // had were the PushToTalk channel and participant names shown in
            // system UI, and PushToTalk was removed on 2026-08-18. App-facing
            // copy is Lingui (JS) and InfoPlist.strings (permission prompts).
        ),
        .testTarget(name: "RadioKitTests", dependencies: ["RadioKit"])
    ]
)
