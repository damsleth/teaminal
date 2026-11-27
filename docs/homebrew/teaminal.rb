class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  version "0.29.0"
  license "MIT"

  depends_on "damsleth/tap/owa-piggy" => :recommended

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-arm64.tar.gz"
      sha256 "486a7b309bd8e83b9dfe176702730d5e4ef40b26854d68d4bb39c59b1d8874ca"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-x64.tar.gz"
      sha256 "4cbe4f253b474aa1de23128a46d6f591e76cae02fbda7b1d5093f0075adbcb1c"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-arm64.tar.gz"
      sha256 "adcd5f07cea90db3f6e2167b0a07edbba976b2cfaa8065b326ac6713a6661c22"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-x64.tar.gz"
      sha256 "85924b5c6697194620f2a1f4070193f59f580e289aac87ae74c836c538bdb191"
    end
  end

  def install
    bin.install "teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
