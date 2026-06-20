import sys
import unittest
import zlib
from pathlib import Path


EXECUTA_DIR = Path(__file__).resolve().parents[2] / "executas" / "resume-reviewer-python"
sys.path.insert(0, str(EXECUTA_DIR))

from resume_reviewer_plugin import _extract_file_text  # noqa: E402


def make_compressed_text_pdf(lines: list[str]) -> bytes:
    text_ops = ["BT", "/F1 12 Tf", "72 720 Td"]
    for index, line in enumerate(lines):
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        if index:
            text_ops.append("T*")
        text_ops.append(f"({escaped}) Tj")
    text_ops.append("ET")
    stream = zlib.compress("\n".join(text_ops).encode("latin-1"))

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{index} 0 obj\n".encode("ascii"))
        pdf.extend(obj)
        pdf.extend(b"\nendobj\n")

    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode(
            "ascii"
        )
    )
    return bytes(pdf)


class PdfExtractionTests(unittest.TestCase):
    def test_extracts_text_from_compressed_pdf_stream(self) -> None:
        raw = make_compressed_text_pdf([
            "Parth Candidate",
            "Frontend engineer intern",
            "React TypeScript accessibility testing",
        ])

        text, note = _extract_file_text(raw, "resume.pdf", "application/pdf")

        self.assertIn("Parth Candidate", text)
        self.assertIn("Frontend engineer intern", text)
        self.assertIn("React TypeScript accessibility testing", text)
        self.assertEqual(note, "pdf text extraction")


if __name__ == "__main__":
    unittest.main()
