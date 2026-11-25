class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  version "0.25.3"
  license "MIT"

  depends_on "damsleth/tap/owa-piggy" => :recommended

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-arm64.tar.gz"
      sha256 "7e0e90819591a82694097a9a422149121d9185a3221e4638dcf4a20229c4c575"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-x64.tar.gz"
      sha256 "99e5c6197b1af2937848c809e22cb5fda0fbfac6a432701862f70999188221a5"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-arm64.tar.gz"
      sha256 "7132d060913ddcd77f6bc45168787a062964e35dd7cfb0cdc689dcb442a29aab"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-x64.tar.gz"
      sha256 "5b1c4a98e7e831670dfb66a6cfb9944bdfd8bdbeeeff0cfb67844255115a4af6"
    end
  end

  def install
    bin.install "teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
