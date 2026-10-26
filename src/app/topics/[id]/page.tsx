import { TopicDetail } from "@/components/TopicDetail";

export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TopicDetail id={id} />;
}
