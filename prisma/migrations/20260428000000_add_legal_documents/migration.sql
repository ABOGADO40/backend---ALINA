-- CreateEnum
CREATE TYPE "enum_legal_document_type" AS ENUM ('PRIVACY_POLICY', 'TERMS_AND_CONDITIONS');

-- CreateTable
CREATE TABLE "legal_documents" (
    "id" SERIAL NOT NULL,
    "type" "enum_legal_document_type" NOT NULL,
    "content" TEXT NOT NULL,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legal_documents_type_key" ON "legal_documents"("type");
