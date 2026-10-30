class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  version "0.25.1"
  license "MIT"

  depends_on "damsleth/tap/owa-piggy" => :recommended

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-arm64.tar.gz"
      sha256 "27ba4d1df4f63f4590bd1915941cc329ede673867f9d6a07ff8be98d903239d2"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-x64.tar.gz"
      sha256 "dc8c2459e3c8d77b2cf25d12127dee2a5125c8d03880f75f04cc9616f2d11b36"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-arm64.tar.gz"
      sha256 "710f68eaba6e205a8c2a14d954173d34f3f9e0380168cdac2de561c38d39bef6"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-x64.tar.gz"
      sha256 "b871270ee585de71ff3153c05792aa3fcb11987ba878d9ba39c020054f7f9970"
    end
  end

  def install
    bin.install "teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
