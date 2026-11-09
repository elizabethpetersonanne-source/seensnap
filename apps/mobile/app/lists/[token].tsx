import { useLocalSearchParams } from 'expo-router';
import { ListReader } from '@/components/list-reader';
export default function SharedListScreen(){
  const {token}=useLocalSearchParams<{token:string}>();
  // Legacy search results used a list UUID where a share token was expected.
  const canonical=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token ?? '');
  return <ListReader endpoint={`${canonical?'/lists':'/public/lists'}/${encodeURIComponent(token ?? '')}`}/>;
}
