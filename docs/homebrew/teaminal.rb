class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  url "https://github.com/damsleth/teaminal.git", branch: "main"
  version "0.12.13"
  license "MIT"
  head "https://github.com/damsleth/teaminal.git", branch: "main"

  depends_on :macos
  depends_on "bun" => :build
  depends_on "damsleth/tap/owa-piggy" => :recommended

  def install
    ENV["TARGET"] = Hardware::CPU.arm? ? "bun-darwin-arm64" : "bun-darwin-x64"

    system "bun", "install", "--frozen-lockfile"
    system "bun", "run", "build"

    bin.install "dist/teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
