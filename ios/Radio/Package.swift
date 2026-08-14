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
            name: "RadioKit",
            dependencies: [
                .product(name: "NearbyConnections", package: "nearby"),
                .product(name: "Opus", package: "swift-opus")
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "RadioKitTests", dependencies: ["RadioKit"])
    ]
)
