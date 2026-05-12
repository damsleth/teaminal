class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  url "https://github.com/damsleth/teaminal.git", branch: "main"
  version "0.12.16"
  license "MIT"
  head "https://github.com/damsleth/teaminal.git", branch: "main"

  depends_on :macos
  depends_on "damsleth/tap/owa-piggy" => :recommended

  # Bun is not in Homebrew (upstream policy: https://bun.com/docs/installation),
  # so we look for it on disk and add its directory to PATH for this build.
  # If it isn't installed, we fail with a one-line install hint rather than
  # silently failing on the first `system "bun"` call.
  def find_bun
    candidates = [
      "#{Dir.home}/.bun/bin/bun",
      "/opt/homebrew/bin/bun",
      "/usr/local/bin/bun",
      "/usr/bin/bun",
    ]
    candidates.find { |p| File.executable?(p) }
  end

  def install
    bun = find_bun
    odie <<~EOS unless bun
      teaminal needs the Bun runtime, which is not distributed via Homebrew.
      Install it once with:

        curl -fsSL https://bun.com/install | bash

      Then re-run: brew install damsleth/tap/teaminal
    EOS

    ENV.prepend_path "PATH", File.dirname(bun)
    ENV["TARGET"] = Hardware::CPU.arm? ? "bun-darwin-arm64" : "bun-darwin-x64"

    system "bun", "install", "--frozen-lockfile"
    system "bun", "run", "build"

    bin.install "dist/teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
